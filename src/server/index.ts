import { logger } from './services/logger.js';
import { streamManager } from './stream_manager.js';

process.on('SIGINT', () => {
  logger.info('Shutting down server...', 'Server');
  streamManager.cleanup();
  setTimeout(() => {
    process.exit(0);
  }, 2000);
}); 