import Router from 'koa-router';
import type { Context } from 'koa';
import { streamManager } from '../stream_manager.js';
import type { StreamOptions, StreamResponse } from '../../types/stream.js';
import { logger } from '../services/logger.js';

const router = new Router();

interface StreamQuery {
  organization?: string;
  limit?: string;
}

// Static routes first (most specific to least specific)
router.get('/api/organizations', (ctx: Context) => {
  ctx.body = streamManager.getOrganizations();
});

// More specific routes before general ones
router.get('/api/streams/active', async (ctx: Context) => {
  try {
    const streams = streamManager.getActiveStreams();
    ctx.body = streams;
  } catch (error: unknown) {
    logger.error(
      'Failed to get active streams',
      'API',
      error instanceof Error ? error : new Error(String(error))
    );
    ctx.status = 500;
    ctx.body = { error: 'Failed to get active streams' };
  }
});

router.get('/api/streams/vtubers', async (ctx: Context) => {
  try {
    const { limit } = ctx.query;
    ctx.body = await streamManager.getVTuberStreams(
      limit ? parseInt(limit as string) : undefined
    );
  } catch (error: unknown) {
    logger.error(
      'Failed to fetch VTuber streams', 
      'API', 
      error instanceof Error ? error : new Error(String(error))
    );
    ctx.status = 500;
    ctx.body = { error: 'Failed to fetch VTuber streams' };
  }
});

router.get('/api/streams/japanese', async (ctx: Context) => {
  try {
    const { limit } = ctx.query;
    ctx.body = await streamManager.getJapaneseStreams(
      limit ? parseInt(limit as string) : undefined
    );
  } catch (error: unknown) {
    logger.error(
      'Failed to fetch Japanese streams', 
      'API', 
      error instanceof Error ? error : new Error(String(error))
    );
    ctx.status = 500;
    ctx.body = { error: 'Failed to fetch Japanese streams' };
  }
});

// General routes
router.get('/api/streams', async (ctx: Context) => {
  try {
    const streams = await streamManager.getLiveStreams();
    ctx.body = streams;
  } catch (error: unknown) {
    logger.error(
      'Failed to get streams',
      'API',
      error instanceof Error ? error : new Error(String(error))
    );
    ctx.status = 500;
    ctx.body = { error: 'Failed to get streams' };
  }
});

router.post('/api/streams', async (ctx: Context) => {
  try {
    const options = ctx.request.body as StreamOptions;
    const result = await streamManager.startStream(options);
    ctx.body = result;
  } catch (error: unknown) {
    logger.error(
      'Failed to start stream',
      'API',
      error instanceof Error ? error : new Error(String(error))
    );
    ctx.status = 500;
    ctx.body = { error: 'Failed to start stream' };
  }
});

// Dynamic route with validation in handler
router.delete('/api/streams/:screen', async (ctx: Context) => {
  try {
    const screen = parseInt(ctx.params.screen);
    if (isNaN(screen)) {
      ctx.status = 400;
      ctx.body = { error: 'Invalid screen number' };
      return;
    }
    const result = await streamManager.stopStream(screen);
    ctx.body = { success: result };
  } catch (error: unknown) {
    logger.error(
      'Failed to stop stream',
      'API',
      error instanceof Error ? error : new Error(String(error))
    );
    ctx.status = 500;
    ctx.body = { error: 'Failed to stop stream' };
  }
});

// Screen Management
router.post('/api/screens/:screen/disable', async (ctx: Context) => {
  try {
    const screen = parseInt(ctx.params.screen);
    if (isNaN(screen)) {
      ctx.status = 400;
      ctx.body = { error: 'Invalid screen number' };
      return;
    }
    await streamManager.disableScreen(screen);
    ctx.body = { success: true };
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: String(error) };
  }
});

router.post('/api/screens/:screen/enable', async (ctx: Context) => {
  try {
    const screen = parseInt(ctx.params.screen);
    if (isNaN(screen)) {
      ctx.status = 400;
      ctx.body = { error: 'Invalid screen number' };
      return;
    }
    await streamManager.enableScreen(screen);
    ctx.body = { success: true };
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: String(error) };
  }
});

// Stream Control
router.post('/api/streams/url', async (ctx: Context) => {
  try {
    const { url, screen, quality } = ctx.request.body as { url: string; screen?: number; quality?: string };
    if (!url) {
      ctx.status = 400;
      ctx.body = { error: 'URL is required' };
      return;
    }
    const result = await streamManager.startStream({ url, screen, quality });
    ctx.body = result;
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: String(error) };
  }
});

router.post('/api/streams/restart', async (ctx: Context) => {
  try {
    const { screen } = ctx.request.body as { screen?: number };
    await streamManager.restartStreams(screen);
    ctx.body = { success: true };
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: String(error) };
  }
});

// Queue Management
router.post('/api/streams/reorder', async (ctx: Context) => {
  try {
    const { screen, sourceIndex, targetIndex } = ctx.request.body as { 
      screen: number; 
      sourceIndex: number; 
      targetIndex: number 
    };
    await streamManager.reorderQueue(screen, sourceIndex, targetIndex);
    ctx.body = { success: true };
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: String(error) };
  }
});

router.get('/api/streams/queue/:screen', async (ctx: Context) => {
  try {
    const screen = parseInt(ctx.params.screen);
    if (isNaN(screen)) {
      ctx.status = 400;
      ctx.body = { error: 'Invalid screen number' };
      return;
    }
    ctx.body = streamManager.getQueueForScreen(screen);
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: String(error) };
  }
});

// Process Priority
router.post('/api/player/priority', async (ctx: Context) => {
  try {
    const { priority } = ctx.request.body as { priority: string };
    await streamManager.setPlayerPriority(priority);
    ctx.body = { success: true };
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: String(error) };
  }
});

// Watched Streams
router.get('/api/streams/watched', async (ctx: Context) => {
  try {
    ctx.body = streamManager.getWatchedStreams();
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: String(error) };
  }
});

router.delete('/api/streams/watched', async (ctx: Context) => {
  try {
    streamManager.clearWatchedStreams();
    ctx.body = { success: true };
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: String(error) };
  }
});

// Server Control
router.post('/api/server/stop', async (ctx: Context) => {
  try {
    // Give time for response to be sent
    setTimeout(() => {
      streamManager.cleanup();
      process.exit(0);
    }, 1000);
    ctx.body = { success: true, message: 'Server stopping...' };
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: String(error) };
  }
});

// Add these new routes after the existing player/priority route
router.post('/api/player/command/:screen', async (ctx: Context) => {
  try {
    const screen = parseInt(ctx.params.screen);
    const { command } = ctx.request.body as { command: string };
    
    if (isNaN(screen)) {
      ctx.status = 400;
      ctx.body = { error: 'Invalid screen number' };
      return;
    }
    
    if (!command) {
      ctx.status = 400;
      ctx.body = { error: 'Command is required' };
      return;
    }

    streamManager.sendCommandToScreen(screen, command);
    ctx.body = { success: true };
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: String(error) };
  }
});

router.post('/api/player/command/all', async (ctx: Context) => {
  try {
    const { command } = ctx.request.body as { command: string };
    
    if (!command) {
      ctx.status = 400;
      ctx.body = { error: 'Command is required' };
      return;
    }

    streamManager.sendCommandToAll(command);
    ctx.body = { success: true };
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: String(error) };
  }
});

// Add after existing player commands
router.post('/api/player/volume/:target', async (ctx: Context) => {
  try {
    const { level } = ctx.request.body as { level: number };
    const target = ctx.params.target;
    
    if (typeof level !== 'number' || level < 0 || level > 100) {
      ctx.status = 400;
      ctx.body = { error: 'Volume must be between 0-100' };
      return;
    }
    
    sendCommand(target, `set volume ${level}`);
    ctx.body = { success: true };
  } catch (error) {
    handleError(ctx, error);
  }
});

router.post('/api/player/pause/:target', async (ctx: Context) => {
  try {
    const target = ctx.params.target;
    sendCommand(target, 'cycle pause');
    ctx.body = { success: true };
  } catch (error) {
    handleError(ctx, error);
  }
});

router.post('/api/player/seek/:target', async (ctx: Context) => {
  try {
    const { seconds } = ctx.request.body as { seconds: number };
    const target = ctx.params.target;
    
    if (typeof seconds !== 'number') {
      ctx.status = 400;
      ctx.body = { error: 'Seconds must be a number' };
      return;
    }
    
    sendCommand(target, `seek ${seconds}`);
    ctx.body = { success: true };
  } catch (error) {
    handleError(ctx, error);
  }
});

// Helper functions
function sendCommand(target: string, command: string) {
  if (target === 'all') {
    streamManager.sendCommandToAll(command);
  } else {
    const screen = parseInt(target);
    if (isNaN(screen)) throw new Error('Invalid screen number');
    streamManager.sendCommandToScreen(screen, command);
  }
}

function handleError(ctx: Context, error: unknown) {
  ctx.status = 500;
  ctx.body = { 
    error: error instanceof Error ? error.message : 'Unknown error',
    timestamp: new Date().toISOString()
  };
}

export const apiRouter = router; 