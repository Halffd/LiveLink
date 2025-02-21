import Router from 'koa-router';
import type { Context } from 'koa';
import { streamManager } from '../stream_manager.js';
import type { StreamSource, PlayerSettings, StreamConfig, StreamOptions } from '../../types/stream.js';
import { logger } from '../services/logger.js';

const router = new Router();

// Add type for request body
interface AddToQueueBody {
  url: string;
  title?: string;
  platform?: string;
}

interface ReorderQueueBody {
  screen: number;
  sourceIndex: number;
  targetIndex: number;
}

interface UpdateConfigBody {
  streams?: StreamConfig[];
  organizations?: string[];
  favoriteChannels?: {
    holodex: string[];
    twitch: string[];
    youtube: string[];
  };
}

interface MarkWatchedBody {
  url: string;
  screen?: number;
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

router.post('/api/streams/start', async (ctx: Context) => {
  try {
    const body = ctx.request.body as { url: string } & Partial<StreamOptions>;
    if (!body.url) {
      ctx.status = 400;
      ctx.body = { error: 'URL is required' };
      return;
    }

    const response = await streamManager.startStream({
      url: body.url,
      screen: body.screen || 1,
      quality: body.quality || 'best',
      volume: body.volume || 50,
      windowMaximized: body.windowMaximized ?? true
    });
    ctx.body = response;
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: error instanceof Error ? error.message : String(error) };
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

    // Check if stream is already playing on this screen
    const activeStreams = streamManager.getActiveStreams();
    const existingStream = activeStreams.find(s => s.screen === screen);
    if (existingStream && existingStream.url === url) {
      ctx.body = { message: 'Stream already playing on this screen' };
      return;
    }

    // Check if stream is playing on a higher priority screen
    const isStreamActive = activeStreams.some(s => 
      s.url === url && s.screen < (screen || 1)
    );
    if (isStreamActive) {
      ctx.body = { message: 'Stream already playing on higher priority screen' };
      return;
    }

    const result = await streamManager.startStream({ 
      url, 
      screen: screen || 1, 
      quality: quality || 'best' 
    });
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
router.get('/api/streams/queue/:screen', async (ctx: Context) => {
  try {
    const screen = parseInt(ctx.params.screen);
    if (isNaN(screen)) {
      ctx.status = 400;
      ctx.body = { error: 'Invalid screen number' };
      return;
    }

    const queue = streamManager.getQueueForScreen(screen);
    ctx.body = queue;
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: String(error) };
  }
});

router.post('/api/streams/queue/:screen', async (ctx: Context) => {
  try {
    const screen = parseInt(ctx.params.screen, 10);
    const body = ctx.request.body as AddToQueueBody;
    
    if (!body.url) {
      ctx.status = 400;
      ctx.body = { error: 'URL is required' };
      return;
    }

    const source: StreamSource = {
      url: body.url,
      title: body.title,
      platform: body.platform
    };

    await streamManager.addToQueue(screen, source);
    ctx.body = { success: true };
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: String(error) };
  }
});

router.delete('/api/streams/queue/:screen/:index', async (ctx: Context) => {
  try {
    const screen = parseInt(ctx.params.screen);
    const index = parseInt(ctx.params.index);
    
    if (isNaN(screen) || isNaN(index)) {
      ctx.status = 400;
      ctx.body = { error: 'Invalid screen number or index' };
      return;
    }

    await streamManager.removeFromQueue(screen, index);
    ctx.body = { success: true };
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: String(error) };
  }
});

router.post('/api/streams/reorder', async (ctx: Context) => {
  try {
    const body = ctx.request.body as ReorderQueueBody;
    
    if (typeof body.screen !== 'number' || typeof body.sourceIndex !== 'number' || typeof body.targetIndex !== 'number') {
      ctx.status = 400;
      ctx.body = { error: 'Invalid parameters' };
      return;
    }

    await streamManager.reorderQueue(body.screen, body.sourceIndex, body.targetIndex);
    ctx.body = { success: true };
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: String(error) };
  }
});

// Add stream control endpoints
router.post('/api/streams/start/:screen', async (ctx: Context) => {
  try {
    const screen = parseInt(ctx.params.screen);
    if (isNaN(screen)) {
      ctx.status = 400;
      ctx.body = { error: 'Invalid screen number' };
      return;
    }

    const { url } = ctx.request.body as { url: string };
    if (!url) {
      ctx.status = 400;
      ctx.body = { error: 'URL is required' };
      return;
    }

    const result = await streamManager.startStream({ url, screen });
    ctx.body = { success: true, ...result };
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: String(error) };
  }
});

router.post('/api/streams/stop/:screen', async (ctx: Context) => {
  try {
    const screen = parseInt(ctx.params.screen);
    if (isNaN(screen)) {
      ctx.status = 400;
      ctx.body = { error: 'Invalid screen number' };
      return;
    }

    await streamManager.stopStream(screen);
    ctx.body = { success: true };
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

router.post('/api/streams/watched', async (ctx: Context) => {
  try {
    const { url } = ctx.request.body as MarkWatchedBody;
    if (!url) {
      ctx.status = 400;
      ctx.body = { error: 'URL is required' };
      return;
    }
    
    // Mark the stream as watched
    streamManager.markStreamAsWatched(url);
    ctx.body = { success: true };
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
    
    if (target === 'all') {
      streamManager.sendCommandToAll(`set volume ${level}`);
    } else {
      const screen = parseInt(target);
      if (isNaN(screen)) {
        ctx.status = 400;
        ctx.body = { error: 'Invalid screen number' };
        return;
      }
      streamManager.sendCommandToScreen(screen, `set volume ${level}`);
    }
    
    ctx.body = { success: true };
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: String(error) };
  }
});

router.post('/api/player/pause/:target', async (ctx: Context) => {
  try {
    const target = ctx.params.target;
    
    if (target === 'all') {
      streamManager.sendCommandToAll('cycle pause');
    } else {
      const screen = parseInt(target);
      if (isNaN(screen)) {
        ctx.status = 400;
        ctx.body = { error: 'Invalid screen number' };
        return;
      }
      streamManager.sendCommandToScreen(screen, 'cycle pause');
    }
    
    ctx.body = { success: true };
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: String(error) };
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
    
    if (target === 'all') {
      streamManager.sendCommandToAll(`seek ${seconds}`);
    } else {
      const screen = parseInt(target);
      if (isNaN(screen)) {
        ctx.status = 400;
        ctx.body = { error: 'Invalid screen number' };
        return;
      }
      streamManager.sendCommandToScreen(screen, `seek ${seconds}`);
    }
    
    ctx.body = { success: true };
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: String(error) };
  }
});

// Get player settings endpoint
router.get('/api/player/settings', async (ctx: Context) => {
  try {
    ctx.body = streamManager.getPlayerSettings();
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: error instanceof Error ? error.message : String(error) };
  }
});

// Update player settings endpoint
router.post('/api/player/settings', async (ctx: Context) => {
  try {
    const settings = ctx.request.body as Partial<PlayerSettings>;
    await streamManager.updatePlayerSettings(settings);
    ctx.body = { success: true };
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: error instanceof Error ? error.message : String(error) };
  }
});

// Add screen configuration endpoints
router.get('/api/screens', (ctx: Context) => {
  ctx.body = streamManager.getScreenConfigs();
});

router.put('/api/screens/:screen', async (ctx: Context) => {
  try {
    const screen = parseInt(ctx.params.screen);
    if (isNaN(screen)) {
      ctx.status = 400;
      ctx.body = { error: 'Invalid screen number' };
      return;
    }

    const config = ctx.request.body as Partial<StreamConfig>;
    streamManager.updateScreenConfig(screen, config);
    ctx.body = { success: true };
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: String(error) };
  }
});

// Add these new routes before the export
router.get('/api/config', (ctx: Context) => {
  ctx.body = streamManager.getConfig();
});

router.put('/api/config', async (ctx: Context) => {
  try {
    const body = ctx.request.body as UpdateConfigBody;
    await streamManager.updateConfig(body);
    ctx.body = { success: true };
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: String(error) };
  }
});

// Screen endpoints
router.get('/screens/:screen', async (ctx) => {
  try {
    const screen = parseInt(ctx.params.screen);
    ctx.body = streamManager.getScreenInfo(screen);
  } catch (error) {
    ctx.status = 400;
    ctx.body = { error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

export const apiRouter = router; 