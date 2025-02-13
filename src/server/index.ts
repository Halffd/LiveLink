import { logger } from './services/logger.js';
import { streamManager } from './stream_manager.js';
import type { StreamInstance } from '../types/stream_instance.js';

process.on('SIGINT', () => {
  logger.info('Shutting down server...', 'Server');
  
  // Force kill all MPV processes
  streamManager.getActiveStreams().forEach((stream) => {
    const processInstance = stream as unknown as StreamInstance;
    if (processInstance.process) {
      const childProcess = processInstance.process as unknown as { pid: number };
      if (childProcess.pid) {
        process.kill(childProcess.pid, 'SIGKILL');
      }
    }
  });

  // Cleanup resources
  streamManager.cleanup();
  
  setTimeout(() => {
    process.exit(0);
  }, 1000);
}); 