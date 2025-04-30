import Koa from 'koa';
import bodyParser from 'koa-bodyparser';
import cors from '@koa/cors';
import serve from 'koa-static';
import path from 'path';
import { fileURLToPath } from 'url';
import { apiRouter } from './routes/api.js';
import appRouter from './router.js';
import { db } from './db/database.js';
import { streamManager } from './stream_manager.js';
import { logger } from './services/logger.js';
import { exec } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = new Koa();

// Initialize database
logger.info('Initializing database...', 'Server');
await db.initialize();
logger.info('Database initialized', 'Server');

// Auto-start streams
/* logger.info('Auto-starting streams...', 'Server');
try {
  await streamManager.autoStartStreams();
  logger.info('Auto-start complete', 'Server');
} catch (error) {
  logger.error('Error during auto-start', 'Server', error as Error);
}
*/
// Middleware
logger.debug('Setting up middleware...', 'Server');
app.use(cors());
app.use(bodyParser());

// Static files
const staticPath = path.join(__dirname, '../../static');
app.use(serve(staticPath));

// Routes
app.use(apiRouter.routes());
app.use(apiRouter.allowedMethods());
app.use(appRouter.routes());
app.use(appRouter.allowedMethods());

// Error handling
app.on('error', (err, ctx) => {
  logger.error('Server error', 'Server', err);
});

const PORT = parseInt(process.env.PORT || '3001', 10);

// Function to check if port is in use
async function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = app.listen(port)
      .once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          resolve(true);
        }
      })
      .once('listening', () => {
        server.close();
        resolve(false);
      });
  });
}

// Function to find and kill process using port
async function killProcessOnPort(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    exec(`lsof -i :${port} | grep LISTEN | awk '{print $2}' | xargs kill -9`, (error) => {
      if (error && error.code !== 1) { // code 1 means no process found
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

// Start server with retry logic
async function startServer(retries = 3): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      if (await isPortInUse(PORT)) {
        logger.warn(`Port ${PORT} is in use, attempting to kill existing process...`, 'Server');
        await killProcessOnPort(PORT);
        // Wait a moment for the port to be freed
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      const server = app.listen(PORT, () => {
        logger.info(`Server running on http://localhost:${PORT}`, 'Server');
        logger.info('Routes:', 'Server');
        apiRouter.stack.forEach(layer => {
          logger.info(`${layer.methods.join(',')} ${layer.path}`, 'Server');
        });
      });

      // Track shutdown state to avoid multiple handlers running
      let isShuttingDown = false;
      
      // Add a more robust shutdown handler
      const handleShutdown = async (signal: string) => {
        if (isShuttingDown) {
          // If already shutting down and user is impatient, force exit
          logger.warn(`Received multiple ${signal} signals during shutdown, forcing exit`, 'Server');
          process.exit(1);
          return;
        }
        
        isShuttingDown = true;
        logger.info(`Received ${signal}. Shutting down gracefully...`, 'Server');
        
        // Create a timeout to force exit if cleanup takes too long
        const forceExitTimeout = setTimeout(() => {
          logger.error('Shutdown timed out after 10 seconds, forcing exit', 'Server');
          process.exit(1);
        }, 10000); // 10 seconds timeout
        
        try {
          // Perform cleanup
          await streamManager.cleanup();
          
          // Close the server
          server.close(() => {
            logger.info('Server closed', 'Server');
            clearTimeout(forceExitTimeout);
            process.exit(0);
          });
          
          // In case server.close callback doesn't fire
          setTimeout(() => {
            logger.info('Server close callback timed out, exiting anyway', 'Server');
            clearTimeout(forceExitTimeout);
            process.exit(0);
          }, 3000);
        } catch (error) {
          logger.error('Error during shutdown:', 'Server', error instanceof Error ? error : new Error(String(error)));
          clearTimeout(forceExitTimeout);
          process.exit(1);
        }
      };

      // Handle various termination signals
      process.on('SIGINT', () => handleShutdown('SIGINT'));
      process.on('SIGTERM', () => handleShutdown('SIGTERM'));
      process.on('SIGHUP', () => handleShutdown('SIGHUP'));

      return;
    } catch (error) {
      logger.error(`Failed to start server (attempt ${i + 1}/${retries})`, 'Server', error as Error);
      if (i === retries - 1) {
        throw error;
      }
      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

// Start the server
try {
  await startServer();
} catch (error) {
  logger.error('Failed to start server after multiple attempts', 'Server', error as Error);
  process.exit(1);
}

export default app;