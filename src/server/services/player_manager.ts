import { Worker } from 'worker_threads';
import { EventEmitter } from 'events';
import type { 
  StreamOptions, 
  WorkerMessage,
  WorkerResponse
} from '../../types/stream.js';
import type {
  StreamOutput,
  StreamError
} from '../../types/stream_instance.js';
import type { Config } from '../../config/loader.js';
import { logger } from './logger.js';

export class PlayerManager extends EventEmitter {
  private workers: Map<number, Worker> = new Map();

  constructor(private config: Config) {
    super();
    this.initialize();
  }

  private initialize() {
    // Create workers for each enabled stream config
    for (const stream of this.config.streams) {
      if (!stream.enabled) continue;

      const worker = new Worker('./dist/server/workers/player_worker.js', {
        workerData: { streamId: stream.id }
      });

      worker.on('message', (message: WorkerResponse) => {
        this.handleWorkerMessage(stream.id, message);
      });

      worker.on('error', (error) => {
        logger.error(
          `Worker ${stream.id} error`,
          'PlayerManager',
          error
        );
        this.emit('error', { streamId: stream.id, error });
      });

      this.workers.set(stream.id, worker);
    }
  }

  private handleWorkerMessage(streamId: number, message: WorkerResponse) {
    switch (message.type) {
      case 'output':
        this.emit('streamOutput', { 
          streamId, 
          screen: message.data.screen,
          data: message.data.data,
          type: message.data.type
        });
        break;
      case 'streamError':
        this.emit('streamError', { 
          streamId, 
          screen: message.data.screen,
          error: message.data.error,
          code: message.data.code
        });
        break;
      case 'startResult':
        this.emit(message.type, { 
          streamId, 
          success: !message.data.error,
          message: message.data.message,
          error: message.data.error
        });
        break;
      case 'stopResult':
        this.emit(message.type, { 
          streamId, 
          success: message.data 
        });
        break;
      case 'error':
        this.emit('error', { 
          streamId, 
          error: message.error 
        });
        break;
    }
  }

  async startStream(streamId: number, options: Omit<StreamOptions, 'screen'>) {
    const worker = this.workers.get(streamId);
    if (!worker) {
      throw new Error(`No worker found for stream ${streamId}`);
    }

    const message: WorkerMessage = {
      type: 'start',
      data: {
        ...options,
        streamId,
        screen: streamId
      }
    };

    worker.postMessage(message);
    return new Promise((resolve, reject) => {
      const handler = (result: any) => {
        if (result.streamId === streamId) {
          this.off('startResult', handler);
          this.off('error', errorHandler);
          resolve(result);
        }
      };
      const errorHandler = (error: any) => {
        if (error.streamId === streamId) {
          this.off('startResult', handler);
          this.off('error', errorHandler);
          reject(error);
        }
      };
      this.on('startResult', handler);
      this.on('error', errorHandler);
    });
  }

  async stopStream(streamId: number) {
    const worker = this.workers.get(streamId);
    if (!worker) {
      throw new Error(`No worker found for stream ${streamId}`);
    }

    worker.postMessage({ type: 'stop', data: streamId });
    // Return promise that resolves when stop is complete
  }

  // Add methods for volume control, quality changes, etc.
} 