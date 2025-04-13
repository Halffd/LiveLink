import { isMainThread, parentPort, workerData } from 'worker_threads';
import { PlayerService } from '../services/player.js';
import type { 
  WorkerMessage, 
  WorkerResponse
} from '../../types/stream.js';
import type {
  StreamOutput,
  StreamError
} from '../../types/stream_instance.js';
import { logger } from '../services/logger.js';
import { loadAllConfigs } from '../../config/loader.js';

if (!isMainThread) {
  const config = loadAllConfigs();
  const player = new PlayerService(config);
  const { streamId } = workerData;
  
  parentPort?.on('message', async (message: WorkerMessage) => {
    try {
      switch (message.type) {
        case 'start': {
          const { screen, ...options } = message.data;
          const result = await player.startStream({
            ...options,
            screen: screen || streamId // Use streamId as fallback
          });
          parentPort?.postMessage({ 
            type: 'startResult', 
            data: result 
          } as WorkerResponse);
          break;
        }
          
        case 'stop': {
          const result = await player.stopStream(message.data);
          parentPort?.postMessage({ 
            type: 'stopResult', 
            data: result.success 
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