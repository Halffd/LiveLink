import Router from 'koa-router';
import type { Context } from 'koa';
import { streamManager } from '../stream_manager.js';
import type { StreamSource, PlayerSettings, StreamConfig, StreamOptions } from '../../types/stream.js';
import { logger, LogLevel } from '../services/logger.js';
import { queueService } from '../services/queue_service.js';

const router = new Router();

function logError(message: string, service: string, error: unknown): void {
  if (error instanceof Error) {
    logger.error(message, service, error);
  } else {
    logger.error(message, service, new Error(String(error)));
  }
}

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
    logError('Failed to get active streams', 'API', error);
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
    logError('Failed to fetch VTuber streams', 'API', error);
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
    logError('Failed to fetch Japanese streams', 'API', error);
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
    logError('Failed to get streams', 'API', error);
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
    logError('Failed to stop stream', 'API', error);
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
    const { url, screen, quality, notify_only } = ctx.request.body as { 
      url: string; 
      screen?: number; 
      quality?: string;
      notify_only?: boolean;
    };
    
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

    // If this is just a notification, don't start the stream
    if (notify_only) {
      ctx.body = { message: 'Stream info updated' };
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
  const screen = parseInt(ctx.params.screen);
  if (isNaN(screen)) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid screen number' };
    return;
  }

  try {
    const queue = streamManager.getQueueForScreen(screen);
    if (!queue) {
      ctx.status = 404;
      ctx.body = { error: `No queue found for screen ${screen}` };
      return;
    }
    ctx.body = queue;
  } catch (error) {
    const errorObj = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to get queue', 'API', errorObj);
    ctx.status = 500;
    ctx.body = { error: 'Internal server error' };
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
    ctx.body = result;
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
    logger.info('Received stop server request', 'API');
    
    // Set response headers to prevent connection from closing
    ctx.set('Connection', 'close');
    
    // Send response before cleanup
    ctx.status = 200;
    ctx.body = { success: true, message: 'Server stopping...' };
    
    // Force send the response
    ctx.res.end();
    
    // Perform cleanup after response is sent
    setTimeout(async () => {
      try {
        logger.info('Starting server cleanup...', 'API');
        await streamManager.cleanup();
        logger.info('Server cleanup complete, exiting...', 'API');
        process.exit(0);
      } catch (error) {
        logError('Failed to cleanup server', 'API', error instanceof Error ? error : new Error(String(error)));
        process.exit(1);
      }
    }, 1000);
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: String(error) };
  }
});

// Stop server and all player processes
router.post('/api/server/stop-all', async (ctx: Context) => {
  try {
    logger.info('Received stop-all request (stopping all players and server)', 'API');
    
    // Set response headers to prevent connection from closing
    ctx.set('Connection', 'close');
    
    // Send response before cleanup
    ctx.status = 200;
    ctx.body = { success: true, message: 'Stopping all players and server...' };
    
    // Force send the response
    ctx.res.end();
    
    // Perform cleanup after response is sent
    setTimeout(async () => {
      try {
        logger.info('Stopping all player processes...', 'API');
        
        // Get all active streams and stop them
        const activeStreams = streamManager.getActiveStreams();
        logger.info(`Active streams: ${JSON.stringify(activeStreams)}`, 'API');
        if (activeStreams.length > 0) {
          logger.info(`Found ${activeStreams.length} active streams to stop`, 'API');
          
          const stopPromises = activeStreams.map(stream => {
            logger.info(`Stopping player on screen ${stream.screen}`, 'API');
            return streamManager.stopStream(stream.screen, true);
          });
          
          // Wait for all streams to be stopped
          await Promise.allSettled(stopPromises);
          logger.info('All player processes stopped', 'API');
        } else {
          logger.info('No active streams to stop', 'API');
        }
        
        // Then perform server cleanup
        logger.info('Starting server cleanup...', 'API');
        await streamManager.cleanup();
        logger.info('Server cleanup complete, exiting...', 'API');
        process.exit(0);
      } catch (error) {
        logError('Failed during stop-all sequence', 'API', error instanceof Error ? error : new Error(String(error)));
        process.exit(1);
      }
    }, 1000);
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

// Add after other stream routes
router.post('/api/streams/autostart', async (ctx: Context) => {
  try {
    const { screen } = ctx.request.body as { screen?: number };
    
    if (screen) {
      // Start streams on specific screen
      const screenConfig = streamManager.getScreenConfig(screen);
      if (!screenConfig) {
        ctx.status = 400;
        ctx.body = { error: `Invalid screen number: ${screen}` };
        return;
      }
      
      // Enable screen if disabled
      if (!screenConfig.enabled) {
        await streamManager.enableScreen(screen);
      }
      
      // Stop any existing streams
      await streamManager.stopStream(screen);
      
      // Start new streams
      await streamManager.handleQueueEmpty(screen);
      ctx.body = { success: true, message: `Auto-started streams on screen ${screen}` };
    } else {
      // Start streams on all screens
      await streamManager.autoStartStreams();
      ctx.body = { success: true, message: 'Auto-started streams on all screens' };
    }
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: String(error) };
  }
});

// Add after other stream routes
router.post('/api/streams/close-all', async (ctx: Context) => {
  try {
    // Get all active screens
    const activeStreams = streamManager.getActiveStreams();
    
    // Stop all streams
    for (const stream of activeStreams) {
      await streamManager.stopStream(stream.screen, true);
    }
    
    ctx.body = { success: true, message: 'All players closed' };
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: String(error) };
  }
});

// Add after other player routes
router.post('/api/log', async (ctx: Context) => {
  try {
    const { screen, type, data } = ctx.request.body as { screen: number; type: string; data: unknown };
    
    if (typeof screen !== 'number' || !type) {
      ctx.status = 400;
      ctx.body = { error: 'Invalid message format' };
      return;
    }

    streamManager.handleLuaMessage(screen, type, data);
    ctx.body = { success: true };
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: String(error) };
  }
});

// Update playlist endpoint
router.post('/api/streams/playlist', async (ctx: Context) => {
  try {
    const { screen, data } = ctx.request.body as { 
      screen: number; 
      data: Array<{
        filename: string;
        title?: string;
        current: boolean;
      }>;
    };

    if (!screen || !Array.isArray(data)) {
      ctx.status = 400;
      ctx.body = { error: 'Invalid playlist data' };
      return;
    }

    // Update playlist in stream manager
    streamManager.handlePlaylistUpdate(screen, data);
    ctx.body = { success: true };
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: String(error) };
  }
});

// Add a refresh endpoint to force stream refresh
router.post('/api/streams/refresh', async (ctx: Context) => {
  try {
    logger.info('Force refreshing all streams', 'API');
    
    // Reset the last refresh timestamps for all screens
    const enabledScreens = streamManager.getEnabledScreens();
    streamManager.resetRefreshTimestamps(enabledScreens);
    
    // Update streams queue for all enabled screens
    await streamManager.updateAllQueues(true);
    
    ctx.body = { success: true, message: 'Stream data refresh initiated for all screens' };
  } catch (error) {
    logError('Failed to refresh streams', 'API', error);
    ctx.status = 500;
    ctx.body = { success: false, error: 'Failed to refresh streams' };
  }
});

// Add a refresh endpoint for specific screen
router.post('/api/streams/refresh/:screen', async (ctx: Context) => {
  try {
    const screen = parseInt(ctx.params.screen);
    
    if (isNaN(screen)) {
      ctx.status = 400;
      ctx.body = { success: false, error: 'Invalid screen number' };
      return;
    }
    
    logger.info(`Force refreshing streams for screen ${screen}`, 'API');
    
    // Reset the refresh timestamp for this screen
    streamManager.resetRefreshTimestamps([screen]);
    
    // Force refresh queue for screen
    logger.info(`Force refreshing queue for screen ${screen}`, 'API');
    await streamManager.updateQueue(screen);
    
    ctx.body = { success: true, message: `Stream data refresh initiated for screen ${screen}` };
  } catch (error) {
    logError(
      `Failed to refresh streams for screen ${ctx.params.screen}`,
      'API',
      error instanceof Error ? error : new Error(String(error))
    );
    ctx.status = 500;
    ctx.body = { success: false, error: 'Failed to refresh streams' };
  }
});

// Server status endpoint
router.get('/api/server/status', async (ctx: Context) => {
  try {
    const uptimeSeconds = process.uptime();
    const uptimeFormatted = formatUptime(uptimeSeconds);
    
    const activeStreams = streamManager.getActiveStreams();
    const memUsage = process.memoryUsage();
    
    ctx.body = {
      status: 'running',
      uptime: uptimeFormatted,
      activeStreams: activeStreams.length,
      version: process.env.npm_package_version || '1.0.0',
      nodeVersion: process.version,
      platform: process.platform,
      memory: {
        rss: `${Math.round(memUsage.rss / 1024 / 1024)} MB`,
        heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)} MB`,
        heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)} MB`,
        external: `${Math.round(memUsage.external / 1024 / 1024)} MB`
      }
    };
  } catch (error) {
    logError('Failed to get server status', 'API', error);
    ctx.status = 500;
    ctx.body = { error: 'Failed to get server status' };
  }
});

// Helper function to format uptime
function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / (3600 * 24));
  const hours = Math.floor((seconds % (3600 * 24)) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (remainingSeconds > 0 || parts.length === 0) parts.push(`${remainingSeconds}s`);
  
  return parts.join(' ');
}

// Add new routes for screen management
router.post('/screens/:screen/toggle', async (ctx) => {
  const screen = parseInt(ctx.params.screen);
  if (isNaN(screen)) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid screen number' };
    return;
  }

  const isEnabled = !streamManager.getScreenConfig(screen)?.enabled;
  if (isEnabled) {
    await streamManager.enableScreen(screen);
  } else {
    await streamManager.disableScreen(screen);
  }
  
  ctx.body = { screen, enabled: isEnabled };
});

router.post('/screens/new-player', async (ctx) => {
  const { screen } = ctx.request.body as { screen?: number };
  
  // Get active streams to avoid duplicates
  const activeStreams = streamManager.getActiveStreams();
  const activeUrls = new Set(activeStreams.map(s => s.url));
  
  // Get all queues
  const queues = [1, 2].map(s => streamManager.getQueueForScreen(s)).flat();
  
  // Find first stream that's not already playing
  const newStream = queues.find(stream => !activeUrls.has(stream.url));
  
  if (!newStream) {
    ctx.status = 404;
    ctx.body = { error: 'No available streams found in queues' };
    return;
  }
  
  // If no specific screen provided, find first available screen
  const targetScreen = screen || activeStreams.length + 1;
  if (targetScreen > 2) {
    ctx.status = 400;
    ctx.body = { error: 'No available screens' };
    return;
  }
  
  // Start the stream
  const result = await streamManager.startStream({
    url: newStream.url,
    screen: targetScreen,
    quality: 'best'
  });
  
  ctx.body = result;
});

// Add new routes for screen toggle and new player
router.post('/api/screens/:screen/toggle', async (ctx: Context) => {
  try {
    const screen = parseInt(ctx.params.screen);
    if (isNaN(screen)) {
      ctx.status = 400;
      ctx.body = { error: 'Invalid screen number' };
      return;
    }
    const config = streamManager.getScreenConfig(screen);
    if (!config) {
      ctx.status = 404;
      ctx.body = { error: 'Screen not found' };
      return;
    }
    if (config.enabled) {
      await streamManager.disableScreen(screen);
    } else {
      await streamManager.enableScreen(screen);
    }
    ctx.body = { success: true, enabled: !config.enabled };
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: String(error) };
  }
});

router.post('/api/screens/:screen/new-player', async (ctx: Context) => {
  try {
    const screen = parseInt(ctx.params.screen);
    if (isNaN(screen)) {
      ctx.status = 400;
      ctx.body = { error: 'Invalid screen number' };
      return;
    }
    const config = streamManager.getScreenConfig(screen);
    if (!config) {
      ctx.status = 404;
      ctx.body = { error: 'Screen not found' };
      return;
    }
    // Stop current stream if any
    await streamManager.stopStream(screen);
    // Start a new player instance
    await streamManager.enableScreen(screen);
    ctx.body = { success: true };
  } catch (error) {
    ctx.status = 500;
    ctx.body = { error: String(error) };
  }
});

// Get stream details for a screen
router.get('/streams/:screen/details', async (ctx: Context) => {
  const screen = parseInt(ctx.params.screen);
  if (isNaN(screen)) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid screen number' };
    return;
  }

  try {
    const streams = streamManager.getActiveStreams();
    const stream = streams.find(s => s.screen === screen);
    
    if (!stream) {
      ctx.status = 404;
      ctx.body = { error: 'No active stream found for this screen' };
      return;
    }

    ctx.body = stream;
  } catch (error) {
    logger.log({
      level: LogLevel.ERROR,
      message: 'Failed to get stream details',
      context: 'API',
      error: error instanceof Error ? error : new Error(String(error))
    });
    ctx.status = 500;
    ctx.body = { error: 'Failed to get stream details' };
  }
});

// Get queue for a screen
router.get('/streams/queue/:screen', async (ctx: Context) => {
  const screen = parseInt(ctx.params.screen, 10);
  if (isNaN(screen) || screen < 1) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid screen number' };
    return;
  }

  try {
    const queue = queueService.getQueue(screen);
    ctx.body = queue;
  } catch (error) {
    const errorObj = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to get queue', 'API', errorObj);
    ctx.status = 500;
    ctx.body = { error: 'Internal server error' };
  }
});

// Refresh queue for a screen
router.post('/streams/queue/:screen/refresh', async (ctx: Context) => {
  const screen = parseInt(ctx.params.screen, 10);
  if (isNaN(screen) || screen < 1) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid screen number' };
    return;
  }

  try {
    await streamManager.updateQueue(screen);
    ctx.status = 200;
    ctx.body = { message: 'Queue refreshed successfully' };
  } catch (error) {
    const errorObj = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to refresh queue', 'API', errorObj);
    ctx.status = 500;
    ctx.body = { 
      error: 'Failed to refresh queue', 
      message: errorObj.message || 'Internal server error',
      details: 'Check server logs for more information'
    };
  }
});

// Get screen info
router.get('/screens/:screen', async (ctx: Context) => {
  const screen = parseInt(ctx.params.screen, 10);
  if (isNaN(screen) || screen < 1) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid screen number' };
    return;
  }

  try {
    const queue = queueService.getQueue(screen);
    const activeStreams = streamManager.getActiveStreams();
    const isActive = activeStreams.some(s => s.screen === screen);
    
    ctx.status = 200;
    ctx.body = {
      enabled: true, // We'll assume enabled if we can get the queue
      queueProcessing: isActive,
      queueLength: queue.length
    };
  } catch (error) {
    const errorObj = error instanceof Error ? error : new Error(String(error));
    logger.error('Failed to get screen info', 'API', errorObj);
    ctx.status = 500;
    ctx.body = { error: 'Internal server error' };
  }
});

export const apiRouter = router; 