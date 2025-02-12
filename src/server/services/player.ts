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
import { queueService } from './queue_service.js';

export class PlayerService {
  private streams: Map<number, StreamInstance> = new Map();
  private events: EventEmitter;
  private outputCallback?: (data: StreamOutput) => void;
  private errorCallback?: (data: StreamError) => void;
  private config = loadAllConfigs();
  private streamRetries: Map<number, number> = new Map();
  private readonly MAX_RETRIES = 3;
  private RETRY_INTERVAL = 10000; // 10 seconds

  constructor() {
    this.events = new EventEmitter();
    
    // Check if mpv is installed
    exec('which mpv', (error, stdout) => {
      if (error) {
        logger.error('MPV is not installed or not in PATH', 'PlayerService', error);
        return;
      }
      logger.debug(`MPV found at: ${stdout.trim()}`, 'PlayerService');
    });
  }

  async startStream(options: StreamOptions & { screen: number }): Promise<StreamResponse> {
    try {
      // If no URL is provided, get next unwatched stream from queue
      if (!options.url) {
        const nextStream = queueService.getNextStream(options.screen);
        if (!nextStream) {
          logger.info(`No unwatched streams left for screen ${options.screen}, will retry in 10s`, 'PlayerService');
          setTimeout(async () => {
            await this.handleEmptyQueue(options.screen);
          }, this.RETRY_INTERVAL);
          return {
            screen: options.screen,
            message: 'No unwatched streams available, will retry'
          };
        }
        options.url = nextStream.url;
      }

      // Mark stream as watched
      queueService.markStreamAsWatched(options.url);

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
          `--volume=${this.config.player.defaultVolume} ` +
          `--geometry=${screenConfig.width}x${screenConfig.height}+${screenConfig.x}+${screenConfig.y} ` +
          `--keep-open=yes --no-terminal --msg-level=all=debug ` +
          `${this.config.player.windowMaximized ? '--window-maximized=yes' : ''}`,
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
          `--volume=${this.config.player.defaultVolume}`,
          `--geometry=${screenConfig.width}x${screenConfig.height}+${screenConfig.x}+${screenConfig.y}`,
          '--keep-open=yes',
          '--no-terminal',
          this.config.player.windowMaximized ? '--window-maximized=yes' : ''
        ];
      }

      logger.debug(`Starting ${command} with args: ${args.join(' ')}`, 'PlayerService');

      const process = spawn(command, args);

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
        
        // Handle different exit codes
        if (code === 0) {
          // Normal exit - try to start next stream
          const nextStream = queueService.getNextStream(options.screen);
          if (nextStream) {
            logger.info(`Starting next stream on screen ${options.screen}: ${nextStream.url}`, 'PlayerService');
            setTimeout(() => {
              this.startStream({
                ...options,
                url: nextStream.url
              });
            }, 1000);
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
        } else if (code === 2) {
          // Code 2 typically means stream is unavailable/offline
          logger.warn(`Stream unavailable on screen ${options.screen}, marking as watched and trying next`, 'PlayerService');
          queueService.markStreamAsWatched(options.url);
          
          const nextStream = queueService.getNextStream(options.screen);
          if (nextStream) {
            logger.info(`Starting next stream on screen ${options.screen}: ${nextStream.url}`, 'PlayerService');
            this.streamRetries.delete(options.screen);
            this.startStream({
              ...options,
              url: nextStream.url
            });
          } else {
            logger.info(`No more streams available for screen ${options.screen}, will retry in 10s`, 'PlayerService');
            setTimeout(() => {
              this.handleEmptyQueue(options.screen);
            }, this.RETRY_INTERVAL);
          }
        } else {
          // Other error codes - handle retries
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
            queueService.markStreamAsWatched(options.url);
            const nextStream = queueService.getNextStream(options.screen);
            if (nextStream) {
              this.startStream({
                ...options,
                url: nextStream.url
              });
            } else {
              logger.info(`No more streams available for screen ${options.screen}, will retry in 10s`, 'PlayerService');
              setTimeout(() => {
                this.handleEmptyQueue(options.screen);
              }, this.RETRY_INTERVAL);
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
    queueService.clearWatchedStreams();
    logger.info('Cleared watched streams history', 'PlayerService');
  }

  isStreamWatched(url: string): boolean {
    return queueService.isStreamWatched(url);
  }

  getWatchedStreams(): string[] {
    return queueService.getWatchedStreams();
  }

  // Get the current queue for a screen
  getStreamQueue(screen: number): string[] {
    return queueService.getQueue(screen).map(s => s.url);
  }

  // Clear the queue for a screen
  clearStreamQueue(screen: number) {
    queueService.clearQueue(screen);
    logger.info(`Cleared stream queue for screen ${screen}`, 'PlayerService');
  }

  // Clear all queues
  clearAllQueues() {
    queueService.clearAllQueues();
    logger.info('Cleared all stream queues', 'PlayerService');
  }

  private async handleEmptyQueue(screen: number) {
    try {
      logger.info(`Attempting to fetch new streams for screen ${screen}`, 'PlayerService');
      // Emit event to trigger stream manager to fetch new streams
      this.errorCallback?.({
        screen,
        error: 'Fetching new streams',
        code: -1
      });
    } catch (error) {
      logger.error(
        'Failed to handle empty queue', 
        'PlayerService',
        error instanceof Error ? error : new Error(String(error))
      );
      // Retry after interval
      setTimeout(() => {
        this.handleEmptyQueue(screen);
      }, this.RETRY_INTERVAL);
    }
  }
} 