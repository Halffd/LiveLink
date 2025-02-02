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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = new Koa();

// Initialize database
logger.info('Initializing database...', 'Server');
await db.initialize();
logger.info('Database initialized', 'Server');

// Auto-start streams
logger.info('Auto-starting streams...', 'Server');
await streamManager.autoStartStreams();
logger.info('Auto-start complete', 'Server');

// Middleware
logger.debug('Setting up middleware...', 'Server');
app.use(cors());
app.use(bodyParser());

// Request logging
app.use(async (ctx, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  logger.debug(`${ctx.method} ${ctx.url} - ${ms}ms`, 'Server');
});

// Error handling
app.on('error', (err, ctx) => {
  logger.error(`Server error: ${err.message} ${ctx}`, 'Server', err);
});

// Serve static files from the build directory
logger.debug('Setting up static file serving...', 'Server');
app.use(serve(path.resolve(__dirname, '../../build')));

// Use routers
logger.debug('Setting up routes...', 'Server');
app.use(apiRouter.routes());
app.use(apiRouter.allowedMethods());
app.use(appRouter.routes());
app.use(appRouter.allowedMethods());

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  logger.info(`Server running on http://localhost:${PORT}`, 'Server');
  logger.info('Routes:', 'Server');
  apiRouter.stack.forEach(layer => {
    logger.info(`${layer.methods.join(',')} ${layer.path}`, 'Server');
  });
});

export default app;