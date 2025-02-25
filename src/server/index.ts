import { logger } from './services/logger.js';
import { streamManager } from './stream_manager.js';
import type { StreamInstance } from '../types/stream_instance.js';
import { exec } from 'child_process';

// Handle multiple termination signals
const signals = ['SIGINT', 'SIGTERM', 'SIGQUIT'];

let isShuttingDown = false;

// Add this before server startup
// Check if API keys are set
const holodexApiKey = process.env.HOLODEX_API_KEY;
const twitchClientId = process.env.TWITCH_CLIENT_ID;
const twitchClientSecret = process.env.TWITCH_CLIENT_SECRET;

if (!holodexApiKey) {
  logger.error('HOLODEX_API_KEY is not set in environment variables', 'Server');
  logger.error('Holodex streams will not be available', 'Server');
}

if (!twitchClientId || !twitchClientSecret) {
  logger.error('TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET is not set in environment variables', 'Server');
  logger.error('Twitch streams will not be available', 'Server');
}

async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info('Shutting down server...', 'Server');
  
  try {
    // Force kill all MPV processes
    const activeStreams = streamManager.getActiveStreams();
    const killPromises = activeStreams.map(async (stream) => {
      const processInstance = stream as unknown as StreamInstance;
      if (processInstance.process) {
        const childProcess = processInstance.process as unknown as { pid: number };
        if (childProcess.pid) {
          try {
            // Try SIGINT first
            process.kill(childProcess.pid, 'SIGINT');
            
            // Wait a bit and force kill if still running
            await new Promise(resolve => setTimeout(resolve, 2000));
            try {
              // Check if process still exists
              process.kill(childProcess.pid, 0);
              // If we get here, process still exists, force kill it
              process.kill(childProcess.pid, 'SIGKILL');
            } catch (e) {
              // Process doesn't exist anymore, which is good
            }
          } catch (e) {
            // Process might already be gone, try SIGKILL
            try {
              process.kill(childProcess.pid, 'SIGKILL');
            } catch {
              // Ignore if process is already gone
            }
          }
        }
      }
    });

    // Wait for all processes to be killed
    await Promise.all(killPromises);

    // Kill any remaining mpv processes
    try {
      await new Promise((resolve, reject) => {
        exec('pkill -9 mpv', (error) => {
          if (error && error.code !== 1) { // code 1 means no processes found
            reject(error);
          } else {
            resolve(undefined);
          }
        });
      });
    } catch (error) {
      logger.error('Error killing remaining mpv processes', 'Server', error as Error);
    }

    // Kill any remaining streamlink processes
    try {
      await new Promise((resolve, reject) => {
        exec('pkill -9 streamlink', (error) => {
          if (error && error.code !== 1) { // code 1 means no processes found
            reject(error);
          } else {
            resolve(undefined);
          }
        });
      });
    } catch (error) {
      logger.error('Error killing remaining streamlink processes', 'Server', error as Error);
    }

    // Cleanup resources
    await streamManager.cleanup();
    
    // Final delay to ensure all cleanup is complete
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown', 'Server', error as Error);
    process.exit(1);
  }
}

// Register signal handlers
signals.forEach(signal => {
  process.on(signal, () => {
    logger.info(`Received ${signal} signal`, 'Server');
    void shutdown();
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', 'Server', error);
  void shutdown();
});

// Handle unhandled rejections
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', 'Server', reason as Error);
  void shutdown();
}); 