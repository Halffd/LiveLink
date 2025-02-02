import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import type { StreamOptions } from '../../types/stream.js';
import type { 
  StreamInstance, 
  StreamOutput, 
  StreamError,
  StreamResponse
} from '../../types/stream_instance.js';
import { logger } from './logger.js';

export class PlayerService {
  private streams: Map<number, StreamInstance> = new Map();
  private events: EventEmitter;
  private outputCallback?: (data: StreamOutput) => void;
  private errorCallback?: (data: StreamError) => void;

  constructor() {
    this.events = new EventEmitter();
  }

  async startStream(options: StreamOptions & { screen: number }): Promise<StreamResponse> {
    logger.debug(`Starting stream with options: ${JSON.stringify(options)}`, 'PlayerService');
    
    if (this.streams.has(options.screen)) {
      logger.debug(`Stopping existing stream on screen ${options.screen}`, 'PlayerService');
      await this.stopStream(options.screen);
    }

    try {
      const platform = options.url.includes('twitch.tv') ? 'twitch' : 'youtube';
      const command = 'streamlink';
      
      const args = this.buildPlayerArgs(options, command);
      logger.debug(`Spawning ${command} with args: ${args.join(' ')}`, 'PlayerService');
      
      const process = spawn(command, args);
      
      process.stdout.on('data', (data) => {
        if (this.outputCallback) {
          this.outputCallback({ 
            screen: options.screen, 
            data: data.toString() 
          });
        }
      });

      process.stderr.on('data', (data) => {
        if (this.errorCallback) {
          this.errorCallback({ 
            screen: options.screen, 
            error: data.toString() 
          });
        }
      });

      const streamInstance: StreamInstance = {
        id: Date.now(),
        process,
        url: options.url,
        quality: options.quality || 'best',
        screen: options.screen,
        platform
      };

      this.streams.set(options.screen, streamInstance);
      logger.info(`Stream started on screen ${options.screen}`, 'PlayerService');
      
      return {
        success: true,
        screen: options.screen,
        message: 'Stream started successfully'
      };
    } catch (error) {
      logger.error(
        'Failed to start stream',
        'PlayerService',
        error instanceof Error ? error : new Error(String(error))
      );
      return {
        success: false,
        screen: options.screen,
        message: `Failed to start stream: ${error}`
      };
    }
  }

  async stopStream(screen: number): Promise<boolean> {
    const stream = this.streams.get(screen);
    if (!stream) return false;

    try {
      stream.process.kill();
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

  private buildPlayerArgs(options: StreamOptions & { screen: number }, player: 'mpv' | 'streamlink'): string[] {
    if (player === 'streamlink') {
      return [
        options.url,
        options.quality || 'best',
        '--player',
        'mpv',
        '--player-args',
        this.buildMpvArgs(options)
      ];
    }

    return [
      options.url,
      this.buildMpvArgs(options)
    ];
  }

  private buildMpvArgs(options: StreamOptions & { screen: number }): string {
    return [
      `--geometry=${this.getScreenGeometry(options.screen)}`,
      `--volume=${options.volume || 0}`,
      ...(options.windowMaximized ? ['--window-maximized'] : [])
    ].join(' ');
  }

  private getScreenGeometry(screen: number): string {
    return `50%x50%+${screen * 1920}+0`;
  }
} 