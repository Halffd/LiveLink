import { EventEmitter } from 'events';
import type { StreamInstance } from '../../types/stream_instance.js';
import type { Config } from '../../types/stream.js';
import { logger } from './logger.js';

interface WorkerData {
  screen: number;
  url: string;
  config: Config;
}

interface WorkerMessage {
  type: string;
  data?: unknown;
}

interface WorkerOptions {
  type?: 'classic' | 'module';
}

declare class Worker extends EventTarget {
  constructor(scriptURL: string | URL, options?: WorkerOptions);
  postMessage(message: WorkerMessage): void;
  terminate(): void;
  onmessage: ((this: Worker, ev: MessageEvent<WorkerMessage>) => void) | null;
  onerror: ((this: Worker, ev: ErrorEvent) => void) | null;
}

export class PlayerManager extends EventEmitter {
  private workers: Map<number, Worker> = new Map();
  private streams: Map<number, StreamInstance> = new Map();
  private config: Config;

  constructor(config: Config) {
    super();
    this.config = config;
    this.initialize();
  }

  private initialize(): void {
    // Create workers for each enabled stream config
    for (const stream of this.config.streams) {
      if (!stream.enabled) continue;

      try {
        const worker = new Worker(new URL('./stream_worker.js', import.meta.url), {
          type: 'module'
        });

        this.workers.set(stream.screen, worker);

        worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
          const message = event.data;
          switch (message.type) {
            case 'streamInfo':
              this.handleStreamInfo(stream.screen, message.data as StreamInstance);
              break;
            case 'error':
              this.handleStreamError(stream.screen, String(message.data));
              break;
          }
        };

        worker.onerror = (event: ErrorEvent) => {
          this.handleStreamError(stream.screen, event.message);
        };
      } catch (error) {
        logger.error(
          `Failed to initialize worker for screen ${stream.screen}`,
          'PlayerManager',
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }
  }

  async startStream(screen: number, url: string): Promise<void> {
    try {
      const worker = this.workers.get(screen);
      if (!worker) {
        throw new Error(`No worker found for screen ${screen}`);
      }

      const data: WorkerData = {
        screen,
        url,
        config: this.config
      };

      worker.postMessage({ type: 'start', data });
    } catch (error) {
      logger.error(
        `Failed to start stream on screen ${screen}`,
        'PlayerManager',
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  async stopStream(screen: number): Promise<void> {
    const worker = this.workers.get(screen);
    if (worker) {
      worker.postMessage({ type: 'stop' });
      worker.terminate();
      this.workers.delete(screen);
      this.streams.delete(screen);
    }
  }

  private handleStreamInfo(screen: number, data: StreamInstance): void {
    this.streams.set(screen, data);
    this.emit('streamUpdate', { screen, data });
  }

  private handleStreamError(screen: number, error: string): void {
    logger.error(`Stream error on screen ${screen}: ${error}`, 'PlayerManager');
    this.emit('streamError', { screen, error });
  }

  // Add methods for volume control, quality changes, etc.
} 