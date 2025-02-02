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
    const streams = await streamManager.getLiveStreams(ctx.query);
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

export const apiRouter = router; 