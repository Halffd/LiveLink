import { isMainThread, parentPort, workerData } from 'worker_threads';
import { PlayerService } from '../services/player.js';
import { loadAllConfigs } from '../../config/loader.js';
import type { 
  WorkerMessage, 
  WorkerResponse
} from '../../types/stream.js';
import type {
  StreamOutput,
  StreamError
} from '../../types/stream_instance.js';
import { logger } from '../services/logger.js';

if (!isMainThread) {
  // Load config
  const config = loadAllConfigs();

  // Initialize player service with config
  const player = new PlayerService(config);
  const { streamId } = workerData;
  
  parentPort?.on('message', async (message: WorkerMessage) => {
    try {
      switch (message.type) {
        case 'start': {
          const { screen, ...options } = message.data;
          const result = await player.startStream({
            ...options,
            screen: screen || streamId, // Use streamId as fallback
            config: {
              screen: screen || streamId,
              id: screen || streamId,
              enabled: true,
              volume: options.volume || 50,
              quality: options.quality || 'best',
              windowMaximized: options.windowMaximized || false,
              sources: [],
              sorting: { field: 'viewerCount', order: 'desc' },
              refresh: 300,
              autoStart: true
            }
          });
          parentPort?.postMessage({ 
            type: 'startResult', 
            data: result 
          } as WorkerResponse);
          break;
        }
          
        case 'stop': {
          const success = await player.stopStream(message.data);
          parentPort?.postMessage({ 
            type: 'stopResult', 
            data: success 
          } as WorkerResponse);
          break;
        }
          
        case 'setVolume': {
          // TODO: Implement volume control
          break;
        }
          
        case 'setQuality': {
          // TODO: Implement quality changes
          break;
        }
      }
    } catch (error) {
      logger.error(
        'Player worker error',
        'PlayerWorker',
        error instanceof Error ? error : new Error(String(error))
      );
      parentPort?.postMessage({ 
        type: 'error', 
        error: error instanceof Error ? error.message : String(error)
      } as WorkerResponse);
    }
  });

  player.onStreamOutput((data: StreamOutput) => {
    parentPort?.postMessage({ 
      type: 'output', 
      data: { streamId, ...data } 
    } as WorkerResponse);
  });

  player.onStreamError((data: StreamError) => {
    parentPort?.postMessage({ 
      type: 'streamError', 
      data: { streamId, ...data } 
    } as WorkerResponse);
  });

  logger.info(`Player worker ${streamId} initialized`, 'PlayerWorker');
} 