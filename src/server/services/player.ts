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

  /**
   * Starts a new stream
   */
  async startStream(options: StreamOptions): Promise<StreamResponse> {
    try {
      const { url, quality = 'best', screen = 1 } = options;

      // Check if screen is already in use
      if (this.streams.has(screen)) {
        return {
          success: false,
          screen,
          message: `Screen ${screen} is already in use`
        };
      }

      // Determine platform from URL
      const platform = url.includes('youtube.com') ? 'youtube' : 'twitch';

      // Start streamlink process
      const process = spawn('streamlink', [
        url,
        quality,
        '--player',
        'mpv',
        '--player-args',
        `--title="Stream ${screen}" --screen=${screen - 1} ${options.windowMaximized ? '--fullscreen' : ''}`
      ]);

      // Handle process output
      process.stdout.on('data', (data) => {
        if (this.outputCallback) {
          this.outputCallback({ screen, data: data.toString() });
        }
      });

      process.stderr.on('data', (data) => {
        if (this.errorCallback) {
          this.errorCallback({ screen, error: data.toString() });
        }
      });

      // Store stream instance
      const streamInstance: StreamInstance = {
        id: Date.now(), // Use timestamp as ID
        process,
        url,
        quality,
        screen,
        platform
      };
      this.streams.set(screen, streamInstance);

      logger.info(`Stream started on screen ${screen}`, 'PlayerService');
      return {
        success: true,
        screen,
        message: `Stream started on screen ${screen}`
      };

    } catch (error) {
      logger.error(
        `Failed to start stream: ${error}`,
        'PlayerService',
        error instanceof Error ? error : new Error(String(error))
      );
      return {
        success: false,
        screen: options.screen || 1,
        message: `Failed to start stream: ${error}`
      };
    }
  }

  async stopStream(screen: number): Promise<boolean> {
    const stream = this.streams.get(screen);
    if (stream) {
      stream.process.kill();
      this.streams.delete(screen);
      logger.info(`Stream stopped on screen ${screen}`, 'PlayerService');
      return true;
    }
    return false;
  }

  getActiveStreams() {
    return Array.from(this.streams.entries()).map(([screen, stream]) => ({
      screen,
      url: stream.url,
      quality: stream.quality,
      title: stream.title,
      platform: stream.platform
    }));
  }

  onStreamOutput(callback: (data: StreamOutput) => void) {
    this.outputCallback = callback;
  }

  onStreamError(callback: (data: StreamError) => void) {
    this.errorCallback = callback;
  }

  private buildPlayerArgs(options: StreamOptions, player: 'mpv' | 'streamlink'): string[] {
    if (player === 'streamlink') {
      return [
        options.url,
        options.quality,
        '--player',
        'mpv',
        '--player-args',
        `--geometry=${this.getScreenGeometry(options.screen)} --volume=${options.volume || 0}${options.windowMaximized ? ' --window-maximized' : ''}`
      ];
    }

    return [
      options.url,
      `--geometry=${this.getScreenGeometry(options.screen)}`,
      `--volume=${options.volume || 0}`,
      ...(options.windowMaximized ? ['--window-maximized'] : [])
    ];
  }

  private getScreenGeometry(screen: number): string {
    return `50%x50%+${screen * 1920}+0`;
  }
} 