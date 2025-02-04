import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import type { StreamOptions, StreamResponse } from '../../types/stream.js';
import type { 
  StreamInstance, 
  StreamOutput, 
  StreamError,
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
    try {
      const process = spawn('mpv', [
        options.url,
        '--no-terminal',
        `--volume=${options.volume || 100}`,
        options.quality ? `--ytdl-format=${options.quality}` : '',
        options.windowMaximized ? '--fullscreen' : ''
      ].filter(Boolean));

      process.stdout.on('data', (data) => {
        this.outputCallback?.({
          screen: options.screen,
          data: data.toString(),
          type: 'stdout'
        });
      });

      process.stderr.on('data', (data) => {
        this.outputCallback?.({
          screen: options.screen,
          data: data.toString(),
          type: 'stderr'
        });
      });

      process.on('error', (error) => {
        this.errorCallback?.({
          screen: options.screen,
          error: error.message
        });
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
        success: true,
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
        success: false,
        screen: options.screen,
        message: error instanceof Error ? error.message : String(error)
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
} 