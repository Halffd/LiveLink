import Router from 'koa-router';
import type { Context } from 'koa';
import { streamManager } from '../stream_manager';
import { AuthorizationCode } from '@twurple/auth';
import { ApiClient } from '@twurple/api';
import { db } from '../db/database';
import type { StreamOptions, StreamResponse } from '../../types/stream';

const router = new Router();

interface StreamQuery {
  organization?: string;
  limit?: string;
  includeCustomTwitch?: string;
}

router.get('/api/organizations', (ctx: Context) => {
  ctx.body = streamManager.getOrganizations();
});

router.get('/api/live', async (ctx: Context) => {
  const { organization, limit, includeCustomTwitch } = ctx.query as StreamQuery;
  
  ctx.body = await streamManager.getLiveStreams({ 
    organization, 
    limit: limit ? parseInt(limit) : undefined,
    includeCustomTwitch: includeCustomTwitch === 'true'
  });
});

router.post('/api/streams', async (ctx: Context) => {
  const options = ctx.request.body as StreamOptions;
  
  if (!options.url || !options.quality || options.screen === undefined) {
    ctx.status = 400;
    ctx.body = { error: 'Missing required parameters' } as StreamResponse;
    return;
  }

  const success = await streamManager.startStream(options);
  
  if (success) {
    ctx.body = { message: 'Stream started successfully' } as StreamResponse;
  } else {
    ctx.status = 500;
    ctx.body = { error: 'Failed to start stream' } as StreamResponse;
  }
});

// ... rest of the routes with proper typing 