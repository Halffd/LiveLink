diff --git a/diff.ts b/diff.ts
deleted file mode 100644
index 3b47431..0000000
--- a/diff.ts
+++ /dev/null
@@ -1,90 +0,0 @@
-diff --git a/src/server/routes/api.ts b/src/server/routes/api.ts
-index 1ea6fbf..f336fd5 100644
---- a/src/server/routes/api.ts
-+++ b/src/server/routes/api.ts
-@@ -277,7 +277,7 @@ router.post('/api/streams/queue/:screen', async (ctx: Context) => {
-     const source: StreamSource = {
-       url: body.url,
-       title: body.title,
--      platform: body.platform
-+      platform: body.platform as 'youtube' | 'twitch' | undefined
-     };
- 
-     await streamManager.addToQueue(screen, source);
-diff --git a/src/types/stream.ts b/src/types/stream.ts
-index 74a2398..18b6522 100644
---- a/src/types/stream.ts
-+++ b/src/types/stream.ts
-@@ -465,4 +465,71 @@ export interface StreamError {
- export interface StreamEnd {
-   screen: string;
-   url: string;
-+}
-+
-+export interface StreamConfig {
-+  /** Screen identifier */
-+  screen: number;
-+  /** Screen ID */
-+  id: number;
-+  /** Whether this screen is enabled */
-+  enabled: boolean;
-+  /** Whether to skip streams that have been watched */
-+  skipWatchedStreams?: boolean;
-+  /** Default volume level (0-100) */
-+  volume: number;
-+  /** Default quality setting */
-+  quality: string;
-+  /** Whether the window should be maximized */
-+  windowMaximized: boolean;
-+  /** Player type to use for this screen (streamlink or mpv) */
-+  playerType?: 'streamlink' | 'mpv' | 'both';
-+  /** X position of the window */
-+  windowX?: number;
-+  /** Y position of the window */
-+  windowY?: number;
-+  /** Width of the window */
-+  windowWidth?: number;
-+  /** Height of the window */
-+  windowHeight?: number;
-+  /** Width of the screen */
-+  width?: number;
-+  /** Height of the screen */
-+  height?: number;
-+  /** X position of the screen */
-+  x?: number;
-+  /** Y position of the screen */
-+  y?: number;
-+  /** Whether this is the primary screen */
-+  primary?: boolean;
-+  /** Stream sources for this screen */
-+  sources?: Array<{
-+    /** Source type (holodex, twitch, youtube) */
-+    type: string;
-+    /** Source subtype (favorites, organization, etc.) */
-+    subtype?: string;
-+    /** Whether this source is enabled */
-+    enabled: boolean;
-+    /** Priority of this source (lower number = higher priority) */
-+    priority?: number;
-+    /** Maximum number of streams to fetch */
-+    limit?: number;
-+    /** Name of the organization (for holodex) */
-+    name?: string;
-+    /** Tags to filter by */
-+    tags?: string[];
-+  }>;
-+  /** Sorting configuration */
-+  sorting?: {
-+    /** Field to sort by */
-+    field: string;
-+    /** Sort order */
-+    order: 'asc' | 'desc';
-+  };
-+  /** Refresh interval in seconds */
-+  refresh?: number;
-+  /** Whether to auto-start streams on this screen */
-+  autoStart?: boolean;
-+  /** Additional screen-specific settings */
-+  [key: string]: unknown;
- } 
-\ No newline at end of file
diff --git a/src/server/config.ts b/src/server/config.ts
index ef8265f..a8494a1 100644
--- a/src/server/config.ts
+++ b/src/server/config.ts
@@ -1,6 +1,7 @@
-import type { StreamConfig, PlayerSettings, FavoriteChannels } from '../types/stream.js';
+import type { ScreenConfig, PlayerSettings, FavoriteChannels } from '../types/stream.js';
 
 export interface Config {
+  screens: ScreenConfig[];
   streams: Array<{
     id: number;
     enabled: boolean;
@@ -35,7 +36,7 @@ export interface Config {
     streamersFile: string;
   };
   player: PlayerSettings & {
-    screens: StreamConfig[];
+    screens: ScreenConfig[];
   };
   mpv: {
     priority?: string;
@@ -49,6 +50,7 @@ export interface Config {
 }
 
 export const defaultConfig: Config = {
+  screens: [],
   streams: [
     {
       id: 1,
diff --git a/src/server/index.ts b/src/server/index.ts
index 18637ae..2a6c74c 100644
--- a/src/server/index.ts
+++ b/src/server/index.ts
@@ -2,6 +2,7 @@ import { logger } from './services/logger.js';
 import { streamManager } from './stream_manager.js';
 import type { StreamInstance } from '../types/stream_instance.js';
 import { exec } from 'child_process';
+import { StreamInfo } from '../types/stream.js';
 
 // Handle multiple termination signals
 const signals = ['SIGINT', 'SIGTERM', 'SIGQUIT'];
@@ -33,7 +34,7 @@ async function shutdown() {
   try {
     // Force kill all MPV processes
     const activeStreams = streamManager.getActiveStreams();
-    const killPromises = activeStreams.map(async (stream) => {
+    const killPromises = activeStreams.map(async (stream: StreamInfo) => {
       const processInstance = stream as unknown as StreamInstance;
       if (processInstance.process) {
         const childProcess = processInstance.process as unknown as { pid: number };
diff --git a/src/server/routes/api.ts b/src/server/routes/api.ts
index f336fd5..0b46cb6 100644
--- a/src/server/routes/api.ts
+++ b/src/server/routes/api.ts
@@ -1,16 +1,25 @@
 import Router from 'koa-router';
 import type { Context } from 'koa';
 import { streamManager } from '../stream_manager.js';
-import type { StreamSource, PlayerSettings, StreamConfig, StreamOptions } from '../../types/stream.js';
-import { logger } from '../services/logger.js';
+import type { StreamSource, PlayerSettings, ScreenConfig, StreamOptions, StreamInfo } from '../../types/stream.js';
+import { logger, LogLevel } from '../services/logger.js';
+import { queueService } from '../services/queue_service.js';
 
 const router = new Router();
 
+function logError(message: string, service: string, error: unknown): void {
+  if (error instanceof Error) {
+    logger.error(message, service, error);
+  } else {
+    logger.error(message, service, new Error(String(error)));
+  }
+}
+
 // Add type for request body
 interface AddToQueueBody {
   url: string;
   title?: string;
-  platform?: string;
+  platform?: 'youtube' | 'twitch';
 }
 
 interface ReorderQueueBody {
@@ -20,7 +29,7 @@ interface ReorderQueueBody {
 }
 
 interface UpdateConfigBody {
-  streams?: StreamConfig[];
+  streams?: ScreenConfig[];
   organizations?: string[];
   favoriteChannels?: {
     holodex: string[];
@@ -45,11 +54,7 @@ router.get('/api/streams/active', async (ctx: Context) => {
     const streams = streamManager.getActiveStreams();
     ctx.body = streams;
   } catch (error: unknown) {
-    logger.error(
-      'Failed to get active streams',
-      'API',
-      error instanceof Error ? error : new Error(String(error))
-    );
+    logError('Failed to get active streams', 'API', error);
     ctx.status = 500;
     ctx.body = { error: 'Failed to get active streams' };
   }
@@ -62,11 +67,7 @@ router.get('/api/streams/vtubers', async (ctx: Context) => {
       limit ? parseInt(limit as string) : undefined
     );
   } catch (error: unknown) {
-    logger.error(
-      'Failed to fetch VTuber streams', 
-      'API', 
-      error instanceof Error ? error : new Error(String(error))
-    );
+    logError('Failed to fetch VTuber streams', 'API', error);
     ctx.status = 500;
     ctx.body = { error: 'Failed to fetch VTuber streams' };
   }
@@ -79,11 +80,7 @@ router.get('/api/streams/japanese', async (ctx: Context) => {
       limit ? parseInt(limit as string) : undefined
     );
   } catch (error: unknown) {
-    logger.error(
-      'Failed to fetch Japanese streams', 
-      'API', 
-      error instanceof Error ? error : new Error(String(error))
-    );
+    logError('Failed to fetch Japanese streams', 'API', error);
     ctx.status = 500;
     ctx.body = { error: 'Failed to fetch Japanese streams' };
   }
@@ -95,11 +92,7 @@ router.get('/api/streams', async (ctx: Context) => {
     const streams = await streamManager.getLiveStreams();
     ctx.body = streams;
   } catch (error: unknown) {
-    logger.error(
-      'Failed to get streams',
-      'API',
-      error instanceof Error ? error : new Error(String(error))
-    );
+    logError('Failed to get streams', 'API', error);
     ctx.status = 500;
     ctx.body = { error: 'Failed to get streams' };
   }
@@ -140,11 +133,7 @@ router.delete('/api/streams/:screen', async (ctx: Context) => {
     const result = await streamManager.stopStream(screen);
     ctx.body = { success: result };
   } catch (error: unknown) {
-    logger.error(
-      'Failed to stop stream',
-      'API',
-      error instanceof Error ? error : new Error(String(error))
-    );
+    logError('Failed to stop stream', 'API', error);
     ctx.status = 500;
     ctx.body = { error: 'Failed to stop stream' };
   }
@@ -201,16 +190,14 @@ router.post('/api/streams/url', async (ctx: Context) => {
 
     // Check if stream is already playing on this screen
     const activeStreams = streamManager.getActiveStreams();
-    const existingStream = activeStreams.find(s => s.screen === screen);
+    const existingStream = activeStreams.find((s: StreamInfo) => s.screen === screen);
     if (existingStream && existingStream.url === url) {
       ctx.body = { message: 'Stream already playing on this screen' };
       return;
     }
 
     // Check if stream is playing on a higher priority screen
-    const isStreamActive = activeStreams.some(s => 
-      s.url === url && s.screen < (screen || 1)
-    );
+    const isStreamActive = activeStreams.some((s: StreamInfo) => s.screen === screen);
     if (isStreamActive) {
       ctx.body = { message: 'Stream already playing on higher priority screen' };
       return;
@@ -247,19 +234,26 @@ router.post('/api/streams/restart', async (ctx: Context) => {
 
 // Queue Management
 router.get('/api/streams/queue/:screen', async (ctx: Context) => {
+  const screen = parseInt(ctx.params.screen);
+  if (isNaN(screen)) {
+    ctx.status = 400;
+    ctx.body = { error: 'Invalid screen number' };
+    return;
+  }
+
   try {
-    const screen = parseInt(ctx.params.screen);
-    if (isNaN(screen)) {
-      ctx.status = 400;
-      ctx.body = { error: 'Invalid screen number' };
+    const queue = streamManager.getQueueForScreen(screen);
+    if (!queue) {
+      ctx.status = 404;
+      ctx.body = { error: `No queue found for screen ${screen}` };
       return;
     }
-
-    const queue = streamManager.getQueueForScreen(screen);
     ctx.body = queue;
   } catch (error) {
+    const errorObj = error instanceof Error ? error : new Error(String(error));
+    logger.error('Failed to get queue', 'API', errorObj);
     ctx.status = 500;
-    ctx.body = { error: String(error) };
+    ctx.body = { error: 'Internal server error' };
   }
 });
 
@@ -274,10 +268,16 @@ router.post('/api/streams/queue/:screen', async (ctx: Context) => {
       return;
     }
 
+    if (body.platform && body.platform !== 'youtube' && body.platform !== 'twitch') {
+      ctx.status = 400;
+      ctx.body = { error: 'Platform must be either "youtube" or "twitch"' };
+      return;
+    }
+
     const source: StreamSource = {
       url: body.url,
       title: body.title,
-      platform: body.platform as 'youtube' | 'twitch' | undefined
+      platform: body.platform
     };
 
     await streamManager.addToQueue(screen, source);
@@ -440,7 +440,7 @@ router.post('/api/server/stop', async (ctx: Context) => {
         logger.info('Server cleanup complete, exiting...', 'API');
         process.exit(0);
       } catch (error) {
-        logger.error('Failed to cleanup server', 'API', error instanceof Error ? error : new Error(String(error)));
+        logError('Failed to cleanup server', 'API', error instanceof Error ? error : new Error(String(error)));
         process.exit(1);
       }
     }, 1000);
@@ -472,10 +472,11 @@ router.post('/api/server/stop-all', async (ctx: Context) => {
         
         // Get all active streams and stop them
         const activeStreams = streamManager.getActiveStreams();
+        logger.info(`Active streams: ${JSON.stringify(activeStreams)}`, 'API');
         if (activeStreams.length > 0) {
           logger.info(`Found ${activeStreams.length} active streams to stop`, 'API');
           
-          const stopPromises = activeStreams.map(stream => {
+          const stopPromises = activeStreams.map((stream: StreamInfo) => {
             logger.info(`Stopping player on screen ${stream.screen}`, 'API');
             return streamManager.stopStream(stream.screen, true);
           });
@@ -493,7 +494,7 @@ router.post('/api/server/stop-all', async (ctx: Context) => {
         logger.info('Server cleanup complete, exiting...', 'API');
         process.exit(0);
       } catch (error) {
-        logger.error('Failed during stop-all sequence', 'API', error instanceof Error ? error : new Error(String(error)));
+        logError('Failed during stop-all sequence', 'API', error instanceof Error ? error : new Error(String(error)));
         process.exit(1);
       }
     }, 1000);
@@ -667,7 +668,7 @@ router.put('/api/screens/:screen', async (ctx: Context) => {
       return;
     }
 
-    const config = ctx.request.body as Partial<StreamConfig>;
+    const config = ctx.request.body as Partial<ScreenConfig>;
     streamManager.updateScreenConfig(screen, config);
     ctx.body = { success: true };
   } catch (error) {
@@ -817,11 +818,7 @@ router.post('/api/streams/refresh', async (ctx: Context) => {
     
     ctx.body = { success: true, message: 'Stream data refresh initiated for all screens' };
   } catch (error) {
-    logger.error(
-      'Failed to refresh streams',
-      'API',
-      error instanceof Error ? error : new Error(String(error))
-    );
+    logError('Failed to refresh streams', 'API', error);
     ctx.status = 500;
     ctx.body = { success: false, error: 'Failed to refresh streams' };
   }
@@ -843,12 +840,13 @@ router.post('/api/streams/refresh/:screen', async (ctx: Context) => {
     // Reset the refresh timestamp for this screen
     streamManager.resetRefreshTimestamps([screen]);
     
-    // Update queue for this screen
-    await streamManager.updateQueue(screen, true);
+    // Force refresh queue for screen
+    logger.info(`Force refreshing queue for screen ${screen}`, 'API');
+    await streamManager.updateQueue(screen);
     
     ctx.body = { success: true, message: `Stream data refresh initiated for screen ${screen}` };
   } catch (error) {
-    logger.error(
+    logError(
       `Failed to refresh streams for screen ${ctx.params.screen}`,
       'API',
       error instanceof Error ? error : new Error(String(error))
@@ -882,11 +880,7 @@ router.get('/api/server/status', async (ctx: Context) => {
       }
     };
   } catch (error) {
-    logger.error(
-      'Failed to get server status',
-      'API',
-      error instanceof Error ? error : new Error(String(error))
-    );
+    logError('Failed to get server status', 'API', error);
     ctx.status = 500;
     ctx.body = { error: 'Failed to get server status' };
   }
@@ -908,4 +902,268 @@ function formatUptime(seconds: number): string {
   return parts.join(' ');
 }
 
+// Add new routes for screen management
+router.post('/screens/:screen/toggle', async (ctx) => {
+  const screen = parseInt(ctx.params.screen);
+  if (isNaN(screen)) {
+    ctx.status = 400;
+    ctx.body = { error: 'Invalid screen number' };
+    return;
+  }
+
+  const isEnabled = !streamManager.getScreenConfig(screen)?.enabled;
+  if (isEnabled) {
+    await streamManager.enableScreen(screen);
+  } else {
+    await streamManager.disableScreen(screen);
+  }
+  
+  ctx.body = { screen, enabled: isEnabled };
+});
+
+router.post('/screens/new-player', async (ctx) => {
+  const { screen } = ctx.request.body as { screen?: number };
+  
+  // Get active streams to avoid duplicates
+  const activeStreams = streamManager.getActiveStreams();
+  const activeUrls = new Set(activeStreams.map((s: StreamInfo) => s.url));
+  
+  // Get all queues
+  const queues = [1, 2].map(s => streamManager.getQueueForScreen(s)).flat();
+  
+  // Find first stream that's not already playing
+  const newStream = queues.find(stream => !activeUrls.has(stream.url));
+  
+  if (!newStream) {
+    ctx.status = 404;
+    ctx.body = { error: 'No available streams found in queues' };
+    return;
+  }
+  
+  // If no specific screen provided, find first available screen
+  const targetScreen = screen || activeStreams.length + 1;
+  if (targetScreen > 2) {
+    ctx.status = 400;
+    ctx.body = { error: 'No available screens' };
+    return;
+  }
+  
+  // Start the stream
+  const result = await streamManager.startStream({
+    url: newStream.url,
+    screen: targetScreen,
+    quality: 'best'
+  });
+  
+  ctx.body = result;
+});
+
+// Add new routes for screen toggle and new player
+router.post('/api/screens/:screen/toggle', async (ctx: Context) => {
+  try {
+    const screen = parseInt(ctx.params.screen);
+    if (isNaN(screen)) {
+      ctx.status = 400;
+      ctx.body = { error: 'Invalid screen number' };
+      return;
+    }
+    const config = streamManager.getScreenConfig(screen);
+    if (!config) {
+      ctx.status = 404;
+      ctx.body = { error: 'Screen not found' };
+      return;
+    }
+    if (config.enabled) {
+      await streamManager.disableScreen(screen);
+    } else {
+      await streamManager.enableScreen(screen);
+    }
+    ctx.body = { success: true, enabled: !config.enabled };
+  } catch (error) {
+    ctx.status = 500;
+    ctx.body = { error: String(error) };
+  }
+});
+
+router.post('/api/screens/:screen/new-player', async (ctx: Context) => {
+  try {
+    const screen = parseInt(ctx.params.screen);
+    if (isNaN(screen)) {
+      ctx.status = 400;
+      ctx.body = { error: 'Invalid screen number' };
+      return;
+    }
+    const config = streamManager.getScreenConfig(screen);
+    if (!config) {
+      ctx.status = 404;
+      ctx.body = { error: 'Screen not found' };
+      return;
+    }
+    // Stop current stream if any
+    await streamManager.stopStream(screen);
+    // Start a new player instance
+    await streamManager.enableScreen(screen);
+    ctx.body = { success: true };
+  } catch (error) {
+    ctx.status = 500;
+    ctx.body = { error: String(error) };
+  }
+});
+
+// Get stream details for a screen
+router.get('/streams/:screen/details', async (ctx: Context) => {
+  const screen = parseInt(ctx.params.screen);
+  if (isNaN(screen)) {
+    ctx.status = 400;
+    ctx.body = { error: 'Invalid screen number' };
+    return;
+  }
+
+  try {
+    const streams = streamManager.getActiveStreams();
+    const stream = streams.find((s: StreamInfo) => s.screen === screen);
+    
+    if (!stream) {
+      ctx.status = 404;
+      ctx.body = { error: 'No active stream found for this screen' };
+      return;
+    }
+
+    ctx.body = stream;
+  } catch (error) {
+    logger.log({
+      level: LogLevel.ERROR,
+      message: 'Failed to get stream details',
+      context: 'API',
+      error: error instanceof Error ? error : new Error(String(error))
+    });
+    ctx.status = 500;
+    ctx.body = { error: 'Failed to get stream details' };
+  }
+});
+
+// Get queue for a screen
+router.get('/streams/queue/:screen', async (ctx: Context) => {
+  const screen = parseInt(ctx.params.screen, 10);
+  if (isNaN(screen) || screen < 1) {
+    ctx.status = 400;
+    ctx.body = { error: 'Invalid screen number' };
+    return;
+  }
+
+  try {
+    const queue = queueService.getQueue(screen);
+    ctx.body = queue;
+  } catch (error) {
+    const errorObj = error instanceof Error ? error : new Error(String(error));
+    logger.error('Failed to get queue', 'API', errorObj);
+    ctx.status = 500;
+    ctx.body = { error: 'Internal server error' };
+  }
+});
+
+// Refresh queue for a screen
+router.post('/streams/queue/:screen/refresh', async (ctx: Context) => {
+  const screen = parseInt(ctx.params.screen, 10);
+  if (isNaN(screen) || screen < 1) {
+    ctx.status = 400;
+    ctx.body = { error: 'Invalid screen number' };
+    return;
+  }
+
+  try {
+    await streamManager.updateQueue(screen);
+    ctx.status = 200;
+    ctx.body = { message: 'Queue refreshed successfully' };
+  } catch (error) {
+    const errorObj = error instanceof Error ? error : new Error(String(error));
+    logger.error('Failed to refresh queue', 'API', errorObj);
+    ctx.status = 500;
+    ctx.body = { 
+      error: 'Failed to refresh queue', 
+      message: errorObj.message || 'Internal server error',
+      details: 'Check server logs for more information'
+    };
+  }
+});
+
+// Get screen info
+router.get('/screens/:screen', async (ctx: Context) => {
+  const screen = parseInt(ctx.params.screen, 10);
+  if (isNaN(screen) || screen < 1) {
+    ctx.status = 400;
+    ctx.body = { error: 'Invalid screen number' };
+    return;
+  }
+
+  try {
+    const queue = queueService.getQueue(screen);
+    const activeStreams = streamManager.getActiveStreams();
+    const isActive = activeStreams.some((s: StreamInfo) => s.screen === screen);
+    
+    ctx.status = 200;
+    ctx.body = {
+      enabled: true, // We'll assume enabled if we can get the queue
+      queueProcessing: isActive,
+      queueLength: queue.length
+    };
+  } catch (error) {
+    const errorObj = error instanceof Error ? error : new Error(String(error));
+    logger.error('Failed to get screen info', 'API', errorObj);
+    ctx.status = 500;
+    ctx.body = { error: 'Internal server error' };
+  }
+});
+
+// Add a new endpoint for manually starting a stream with a URL
+router.post('/streams/manual-start', async (ctx: Context) => {
+  try {
+    const { url, screen, quality } = ctx.request.body as { url: string; screen: number; quality?: string };
+    
+    if (!url) {
+      ctx.status = 400;
+      ctx.body = { success: false, error: 'URL is required' };
+      return;
+    }
+    
+    if (!screen || isNaN(screen)) {
+      ctx.status = 400;
+      ctx.body = { success: false, error: 'Valid screen number is required' };
+      return;
+    }
+    
+    // Use the logError helper function defined in this file
+    console.log(`Manually starting stream ${url} on screen ${screen}`);
+    
+    // First stop any existing stream on this screen
+    const activeStreams = streamManager.getActiveStreams();
+    const currentStream = activeStreams.find((s: StreamInfo) => s.screen === screen);
+    
+    if (currentStream) {
+      console.log(`Stopping current stream on screen ${screen} before starting new one`);
+      await streamManager.stopStream(screen, true);
+    }
+    
+    // Start the requested stream
+    const result = await streamManager.startStream({
+      url,
+      screen,
+      quality: quality || 'best',
+      windowMaximized: true
+    });
+    
+    if (result.success) {
+      ctx.body = { success: true, message: `Stream started on screen ${screen}` };
+    } else {
+      ctx.status = 500;
+      ctx.body = { success: false, error: result.error || 'Failed to start stream' };
+    }
+  } catch (error) {
+    // Use the logError helper function
+    logError('Failed to manually start stream', 'API', error);
+    ctx.status = 500;
+    ctx.body = { success: false, error: 'Internal server error' };
+  }
+});
+
 export const apiRouter = router; 
\ No newline at end of file
diff --git a/src/server/services/holodex.ts b/src/server/services/holodex.ts
index d4214f4..bc08ad0 100644
--- a/src/server/services/holodex.ts
+++ b/src/server/services/holodex.ts
@@ -47,8 +47,8 @@ export class HolodexService implements StreamService {
 
       const params: Record<string, string | number> = {
         limit: options.limit || 25,
-        sort: options.sort || 'available_at',
-        order: 'asc'
+        sort: options.sort || 'live_viewers',
+        order: options.sort === 'available_at' ? 'asc' : 'desc'
       };
 
       const organization = options?.organization;
@@ -68,7 +68,7 @@ export class HolodexService implements StreamService {
           this.client!.getLiveVideos({
             channel_id: channelId,
             status: 'live' as VideoStatus,
-            type: 'stream' as VideoType,
+            type: 'live' as VideoType,
             max_upcoming_hours: 0,
             sort: 'live_viewers' as keyof VideoRaw & string,
           }).catch(error => {
@@ -92,7 +92,7 @@ export class HolodexService implements StreamService {
             channelVideos.sort((a, b) => {
               if (a.status === 'live' && b.status !== 'live') return -1;
               if (a.status !== 'live' && b.status === 'live') return 1;
-              return (b.liveViewers || 0) - (a.liveViewers || 0);
+              return 0;
             });
             videos.push(...channelVideos);
           }
@@ -169,25 +169,19 @@ export class HolodexService implements StreamService {
           if (a.sourceStatus === 'live' && b.sourceStatus !== 'live') return -1;
           if (a.sourceStatus !== 'live' && b.sourceStatus === 'live') return 1;
           
-          // Then by viewer count for streams from the same channel
-          return (b.viewerCount || 0) - (a.viewerCount || 0);
+          return 0;
         });
       } else {
         // For non-favorite streams, sort by:
         // 1. Live status
         // 2. Viewer count
-        // 3. Start time
         streamSources.sort((a, b) => {
+          // First by live status
           if (a.sourceStatus === 'live' && b.sourceStatus !== 'live') return -1;
           if (a.sourceStatus !== 'live' && b.sourceStatus === 'live') return 1;
           
-          if (a.sourceStatus === 'live' && b.sourceStatus === 'live') {
-            return (b.viewerCount || 0) - (a.viewerCount || 0);
-          }
-          
-          const aTime = a.startTime || 0;
-          const bTime = b.startTime || 0;
-          return aTime - bTime;
+          // Then by viewer count
+          return (b.viewerCount || 0) - (a.viewerCount || 0);
         });
       }
 
diff --git a/src/server/services/player.ts b/src/server/services/player.ts
index a40121f..ae6471a 100644
--- a/src/server/services/player.ts
+++ b/src/server/services/player.ts
@@ -1,20 +1,14 @@
 import { spawn, type ChildProcess } from 'child_process';
 import { EventEmitter } from 'events';
-import type { StreamOptions } from '../../types/stream.js';
-import type {
-	StreamOutput,
-	StreamError,
-	StreamResponse
-} from '../../types/stream_instance.js';
-import { logger } from '../services/logger/index.js';
-import { loadAllConfigs } from '../../config/loader.js';
-import { exec } from 'child_process';
+import type { Config, StreamlinkConfig, ScreenConfig } from '../../types/stream.js';
+import type { StreamOutput, StreamError, StreamResponse, StreamEnd } from '../../types/stream_instance.js';
+import { logger } from './logger.js';
+import { exec, execSync } from 'child_process';
 import path from 'path';
 import fs from 'fs';
-import { execSync } from 'child_process';
 import net from 'net';
 
-interface StreamInstance {
+interface LocalStreamInstance {
 	id: number;
 	screen: number;
 	url: string;
@@ -28,6 +22,21 @@ interface StreamInstance {
 	options: StreamOptions & { screen: number };
 }
 
+export interface StreamOptions {
+	screen: number;
+	config: ScreenConfig;
+	url: string;
+	isLive?: boolean;
+	isWatched?: boolean;
+	isRetry?: boolean;
+	title?: string;
+	viewerCount?: number;
+	startTime?: number;
+	quality?: string;
+	volume?: number;
+	windowMaximized?: boolean;
+}
+
 export class PlayerService {
 	private readonly BASE_LOG_DIR: string;
 	private readonly MAX_RETRIES = 2;
@@ -37,7 +46,7 @@ export class PlayerService {
 	private readonly STARTUP_TIMEOUT = 60000; // 10 minutes
 	private readonly SHUTDOWN_TIMEOUT = 2000; // Increased from 100ms to 1 second
 	private readonly SCRIPTS_PATH: string;
-	private streams: Map<number, StreamInstance> = new Map();
+	private streams: Map<number, LocalStreamInstance> = new Map();
 	private streamRetries: Map<number, number> = new Map();
 	private streamStartTimes: Map<number, number> = new Map();
 	private streamRefreshTimers: Map<number, NodeJS.Timeout> = new Map();
@@ -48,17 +57,41 @@ export class PlayerService {
 	private disabledScreens: Set<number> = new Set();
 	private ipcPaths: Map<number, string> = new Map();
 
-	private config = loadAllConfigs();
+	private config: Config;
 	private mpvPath: string;
 	private isShuttingDown = false;
 	private events = new EventEmitter();
 	private outputCallback?: (data: StreamOutput) => void;
 	private errorCallback?: (data: StreamError) => void;
+	private endCallback?: (data: StreamEnd) => void;
+
+	public readonly DUMMY_SOURCE = '';  // Empty string instead of black screen URL
+
+	private readonly streamlinkConfig: StreamlinkConfig;
+	private readonly retryTimers: Map<number, NodeJS.Timeout>;
 
-	constructor() {
+	constructor(config: Config) {
+		this.config = config;
+		this.streamlinkConfig = config.streamlink || {
+			path: 'streamlink',
+			options: {},
+			http_header: {}
+		};
+		this.streams = new Map();
+		this.ipcPaths = new Map();
+		this.disabledScreens = new Set();
+		this.retryTimers = new Map();
+		
+		// Set up paths
 		this.BASE_LOG_DIR = path.join(process.cwd(), 'logs');
-		this.mpvPath = this.findMpvPath();
-		this.SCRIPTS_PATH = path.join(process.cwd(), 'scripts', 'mpv');
+		this.SCRIPTS_PATH = path.join(process.cwd(), 'scripts/mpv');
+		this.mpvPath = 'mpv';
+
+		// Create log directory if it doesn't exist
+		if (!fs.existsSync(this.BASE_LOG_DIR)) {
+			fs.mkdirSync(this.BASE_LOG_DIR, { recursive: true });
+		}
+
 		this.initializeDirectories();
 		this.registerSignalHandlers();
 	}
@@ -148,163 +181,154 @@ export class PlayerService {
 	}
 
 	async startStream(options: StreamOptions & { screen: number }): Promise<StreamResponse> {
-		const { screen } = options;
-
-		// Check maximum streams limit
-		const activeStreams = Array.from(this.streams.values()).filter((s) => s.process !== null);
-		if (activeStreams.length >= this.config.player.maxStreams) {
-			return {
-				screen,
-				message: `Maximum number of streams (${this.config.player.maxStreams}) reached`,
-				error: `Maximum number of streams (${this.config.player.maxStreams}) reached`,
-				success: false
-			};
-		}
-
-		// Check startup lock
-		if (this.startupLocks.get(screen)) {
-			return {
-				screen,
-				message: `Stream startup in progress for screen ${screen}`,
-				success: false
-			};
-		}
-
-		// Set startup lock with timeout
-		this.startupLocks.set(screen, true);
-		const lockTimeout = setTimeout(() => {
-			this.startupLocks.set(screen, false);
-		}, this.STARTUP_TIMEOUT);
-
 		try {
-			// Stop existing stream if any
-			await this.stopStream(screen);
-
-			// Get screen configuration
-			const screenConfig = this.config.player.screens.find((s) => s.screen === screen);
-			if (!screenConfig) {
-				throw new Error(`Invalid screen number: ${screen}`);
-			}
-
 			// Check if screen is disabled
-			if (this.disabledScreens.has(screen)) {
-				throw new Error(`Screen ${screen} is disabled`);
+			if (this.disabledScreens.has(options.screen)) {
+				logger.warn(`Attempted to start stream on disabled screen ${options.screen}`, 'PlayerService');
+			return {
+					screen: options.screen,
+					success: false,
+					error: 'Screen is disabled'
+				};
 			}
 
-			// Don't start during shutdown
-			if (this.isShuttingDown) {
-				throw new Error('Server is shutting down');
+			// Check if we're already starting a stream on this screen
+			if (this.startupLocks.get(options.screen)) {
+				logger.warn(`Stream startup already in progress for screen ${options.screen}`, 'PlayerService');
+			return {
+					screen: options.screen,
+					success: false,
+					error: 'Stream startup already in progress'
+				};
 			}
 
-			// Clear manually closed flag - we're explicitly starting a new stream
-			this.manuallyClosedScreens.delete(screen);
-
-			// Determine player type
-			const useStreamlink =
-				screenConfig.playerType === 'streamlink' ||
-				(!screenConfig.playerType && this.config.player.preferStreamlink);
+			// Set startup lock
+			this.startupLocks.set(options.screen, true);
 
-			// Ensure we have metadata for the title
-			const streamTitle =
-				options.title || this.extractTitleFromUrl(options.url) || 'Unknown Stream';
+			// Stop any existing stream first
+			await this.stopStream(options.screen);
 
-			// Get current date/time for the title
-			const currentTime = new Date().toLocaleTimeString();
+			// Initialize directories if needed
+			this.initializeDirectories();
 
-			// Add metadata to options for use in player commands
-			options.title = streamTitle;
-			options.viewerCount = options.viewerCount || 0;
-			options.startTime = options.startTime || currentTime;
+			// Initialize IPC path
+			const homedir = process.env.HOME || process.env.USERPROFILE;
+			const ipcPath = homedir
+				? path.join(homedir, '.livelink', `mpv-ipc-${options.screen}`)
+				: `/tmp/mpv-ipc-${options.screen}`;
+			this.ipcPaths.set(options.screen, ipcPath);
 
 			logger.info(
-				`Starting stream with title: ${streamTitle}, viewers: ${options.viewerCount}, time: ${options.startTime}, screen: ${screen}`,
+				`Starting stream with title: ${options.title}, viewers: ${options.viewerCount}, time: ${options.startTime}, screen: ${options.screen}`,
 				'PlayerService'
 			);
 
-			// Start the stream
-			const process = useStreamlink
-				? await this.startStreamlinkProcess(options)
-				: await this.startMpvProcess(options);
+			let playerProcess: ChildProcess;
+			if (this.config.player.preferStreamlink || options.url.includes('twitch.tv')) {
+				logger.info(`Starting Streamlink for screen ${options.screen}`, 'PlayerService');
+				playerProcess = await this.startStreamlinkProcess(options);
+			} else {
+				logger.info(`Starting MPV for screen ${options.screen}`, 'PlayerService');
+				playerProcess = await this.startMpvProcess(options);
+			}
+
+			if (!playerProcess || !playerProcess.pid) {
+				throw new Error('Failed to start player process');
+			}
 
-			// Create stream instance
-			const instance: StreamInstance = {
+			// Create stream instance and store it
+			const streamInstance: LocalStreamInstance = {
 				id: Date.now(),
-				screen,
+				screen: options.screen,
 				url: options.url,
-				quality: options.quality || 'best',
+				quality: options.quality || this.config.player.defaultQuality,
 				status: 'playing',
-				volume: options.volume || screenConfig.volume || this.config.player.defaultVolume,
-				process,
-				platform: options.url.includes('youtube.com') ? 'youtube' : 'twitch',
-				title: streamTitle,
-				startTime:
-					typeof options.startTime === 'string'
-						? new Date(options.startTime).getTime()
-						: options.startTime,
-				options: options
+				volume: options.volume || 0,
+				process: playerProcess,
+				platform: options.url.includes('twitch.tv') ? 'twitch' : 'youtube',
+				title: options.title,
+				startTime: typeof options.startTime === 'string' ? new Date(options.startTime).getTime() : options.startTime,
+				options
 			};
 
-			// Store stream instance
-			this.streams.set(screen, instance);
+			// Store stream instance before setting up handlers
+			this.streams.set(options.screen, streamInstance);
+			
+			// Set up process handlers and monitoring
+			this.setupProcessHandlers(playerProcess, options.screen);
+			this.setupStreamMonitoring(options.screen, playerProcess, options);
+
+			// Clear startup lock
+			this.startupLocks.set(options.screen, false);
 
-			// Setup monitoring
-			this.setupStreamMonitoring(screen, process, options);
+			// Double check the stream was added correctly
+			const addedStream = this.streams.get(options.screen);
+			if (!addedStream || !addedStream.process || !addedStream.process.pid) {
+				throw new Error('Stream was not properly initialized');
+			}
 
+			logger.info(`Stream started successfully on screen ${options.screen} with PID ${addedStream.process.pid}`, 'PlayerService');
 			return {
-				screen,
-				message: `Stream started on screen ${screen}`,
+				screen: options.screen,
 				success: true
 			};
 		} catch (error) {
+			// Clear startup lock on error
+			this.startupLocks.set(options.screen, false);
+			
+			// Clean up any partially initialized stream
+			this.cleanup_after_stop(options.screen);
+			
 			logger.error(
-				`Failed to start stream on screen ${screen}`,
+				`Failed to start stream on screen ${options.screen}`,
 				'PlayerService',
 				error instanceof Error ? error : new Error(String(error))
 			);
+
 			return {
-				screen,
-				message: error instanceof Error ? error.message : String(error),
-				success: false
+				screen: options.screen,
+				success: false,
+				error: error instanceof Error ? error.message : String(error)
 			};
-		} finally {
-			clearTimeout(lockTimeout);
-			this.startupLocks.set(screen, false);
 		}
 	}
 
-	private async startMpvProcess(
-		options: StreamOptions & { screen: number }
-	): Promise<ChildProcess> {
-		const args = this.getMpvArgs(options);
-		const env = this.getProcessEnv();
-
-		// Add screen-specific environment variables
-		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
-		env.SCREEN = options.screen.toString();
-		env.DATE = timestamp;
+	private async startMpvProcess(options: StreamOptions & { screen: number }): Promise<ChildProcess> {
+		logger.info(`Starting MPV for screen ${options.screen}`, 'PlayerService');
 
-		// Sanitize title components to avoid issues with shell escaping
-		const streamTitle = (options.title || 'Unknown Title').replace(/['"]/g, '');
-		const viewerCount =
-			options.viewerCount !== undefined ? `${options.viewerCount} viewers` : 'Unknown viewers';
-		const startTime = options.startTime
-			? new Date(options.startTime).toLocaleTimeString()
-			: 'Unknown time';
+		// Ensure IPC path is initialized
+		if (!this.ipcPaths.has(options.screen)) {
+			const homedir = process.env.HOME || process.env.USERPROFILE;
+			const ipcPath = homedir
+				? path.join(homedir, '.livelink', `mpv-ipc-${options.screen}`)
+				: `/tmp/mpv-ipc-${options.screen}`;
+			this.ipcPaths.set(options.screen, ipcPath);
+		}
 
-		// Set environment variables without quotes
-		env.TITLE = `${streamTitle} - ${viewerCount} - ${startTime} - Screen ${options.screen}`;
-		env.STREAM_URL = options.url;
+		const args = this.getMpvArgs(options);
+		const env = this.getProcessEnv();
 
-		logger.info(`Starting MPV for screen ${options.screen}`, 'PlayerService');
-		logger.debug(`MPV command: ${this.mpvPath} ${args.join(' ')}`, 'PlayerService');
+		logger.debug(`Starting MPV with command: ${this.mpvPath} ${args.join(' ')}`, 'PlayerService');
 
-		const process = spawn(this.mpvPath, args, {
+		const mpvProcess = spawn(this.mpvPath, args, {
 			env,
 			stdio: ['ignore', 'pipe', 'pipe']
 		});
 
-		this.setupProcessHandlers(process, options.screen);
-		return process;
+		// Set up logging for the process
+		if (mpvProcess.stdout) {
+			mpvProcess.stdout.on('data', (data: Buffer) => {
+				logger.debug(`MPV stdout (screen ${options.screen}): ${data.toString().trim()}`, 'PlayerService');
+			});
+		}
+
+		if (mpvProcess.stderr) {
+			mpvProcess.stderr.on('data', (data: Buffer) => {
+				logger.debug(`MPV stderr (screen ${options.screen}): ${data.toString().trim()}`, 'PlayerService');
+			});
+		}
+
+		return mpvProcess;
 	}
 
 	private async startStreamlinkProcess(
@@ -313,93 +337,127 @@ export class PlayerService {
 		const args = this.getStreamlinkArgs(options.url, options);
 		const env = this.getProcessEnv();
 
-		logger.info(`Starting Streamlink for screen ${options.screen}`, 'PlayerService');
-		logger.debug(`Streamlink command: streamlink ${args.join(' ')}`, 'PlayerService');
-
-		// Check if there's already a process for this screen
-		const existingStream = this.streams.get(options.screen);
-		if (existingStream?.process) {
-			try {
-				existingStream.process.kill('SIGTERM');
-				await new Promise<void>((resolve) => {
-					const timeout = setTimeout(() => {
-						try {
-							existingStream.process?.kill('SIGKILL');
-						} catch {
-							// Process might already be gone
-						}
-						resolve();
-					}, this.SHUTDOWN_TIMEOUT);
-
-					existingStream.process?.once('exit', () => {
-						clearTimeout(timeout);
-						resolve();
-					});
-				});
-			} catch (error) {
-				logger.warn(
-					`Error stopping existing process on screen ${options.screen}`,
-					'PlayerService',
-					error instanceof Error ? error : new Error(String(error))
-				);
-			}
-		}
-
-		// Clear any existing state
-		this.clearMonitoring(options.screen);
-		this.streams.delete(options.screen);
-
-		// Start new process
-		const process = spawn('streamlink', args, {
+		try {
+			const process = spawn(this.streamlinkConfig.path || 'streamlink', args, {
 			env,
 			stdio: ['ignore', 'pipe', 'pipe']
 		});
 
-		// Set up process handlers
-		this.setupProcessHandlers(process, options.screen);
-
-		// Wait for streamlink to initialize
-		await new Promise<void>((resolve, reject) => {
-			const timeout = setTimeout(() => {
-				reject(new Error('Streamlink startup timeout'));
+			return new Promise((resolve, reject) => {
+				let errorOutput = '';
+				let hasStarted = false;
+				const startTimeout = setTimeout(() => {
+					const error = new Error('Stream start timeout exceeded');
+					this.logError(
+						`Stream start timeout on screen ${options.screen}`,
+						'PlayerService',
+						error
+					);
+					process.kill();
+					reject(error);
 			}, this.STARTUP_TIMEOUT);
 
 			const onData = (data: Buffer) => {
 				const output = data.toString();
-				if (output.includes('Available streams:')) {
-					cleanup();
-					resolve();
+					if (output.includes('Starting player')) {
+						hasStarted = true;
+						clearTimeout(startTimeout);
+						resolve(process);
+					}
+					// Check for common error patterns
+					if (output.toLowerCase().includes('error')) {
+						errorOutput += output + '\n';
 				}
 			};
 
 			const onError = (error: Error) => {
-				cleanup();
+					clearTimeout(startTimeout);
+					this.logError(
+						`Failed to start streamlink for screen ${options.screen}`,
+						'PlayerService',
+						error
+					);
 				reject(error);
 			};
 
 			const onExit = (code: number | null) => {
-				cleanup();
-				if (code !== null && code !== 0) {
-					reject(new Error(`Streamlink exited with code ${code}`));
-				}
-			};
-
-			const cleanup = () => {
-				clearTimeout(timeout);
-				process.stdout?.removeListener('data', onData);
-				process.removeListener('error', onError);
-				process.on('exit', onExit);
-			};
+					clearTimeout(startTimeout);
+					if (!hasStarted) {
+						let errorMessage = 'Stream failed to start';
+						
+						// Enhanced error detection
+						if (errorOutput.toLowerCase().includes('members-only')) {
+							errorMessage = 'Stream unavailable (members-only content)';
+						} else if (errorOutput.toLowerCase().includes('no playable streams')) {
+							errorMessage = 'No playable streams found';
+						} else if (errorOutput.toLowerCase().includes('404')) {
+							errorMessage = 'Stream not found (404)';
+						} else if (errorOutput.toLowerCase().includes('private')) {
+							errorMessage = 'Stream is private';
+						} else if (code === 1) {
+							errorMessage = 'Stream unavailable (possibly members-only content)';
+						} else if (code === 130) {
+							errorMessage = 'Stream process interrupted';
+						} else if (code === 2) {
+							errorMessage = 'Stream unavailable or invalid URL';
+						}
+						
+						const error = new Error(errorMessage);
+						this.logError(
+							`Stream failed to start on screen ${options.screen} (code ${code})`,
+							'PlayerService',
+							error
+						);
+						reject(error);
+					}
+				};
 
-			process.stdout?.on('data', onData);
+				process.stdout.on('data', onData);
+				process.stderr.on('data', (data: Buffer) => {
+					errorOutput += data.toString() + '\n';
+					onData(data);
+				});
 			process.on('error', onError);
 			process.on('exit', onExit);
 		});
-
-		return process;
+		} catch (error) {
+			this.logError(
+				`Failed to spawn streamlink process for screen ${options.screen}`,
+				'PlayerService',
+				error
+			);
+			throw error;
+		}
 	}
 
 	private setupProcessHandlers(process: ChildProcess, screen: number): void {
+		let hasEndedStream = false;
+		let cleanupTimeout: NodeJS.Timeout | null = null;
+
+		const cleanup = () => {
+			if (cleanupTimeout) {
+				clearTimeout(cleanupTimeout);
+				cleanupTimeout = null;
+			}
+			this.clearMonitoring(screen);
+			this.streams.delete(screen);
+			this.streamRetries.delete(screen);
+		};
+
+		const handleStreamEnd = (error: string, code: number = 0) => {
+			if (!hasEndedStream) {
+				hasEndedStream = true;
+				logger.info(`Stream ended on screen ${screen}`, 'PlayerService');
+				this.errorCallback?.({
+					screen,
+					error,
+					code
+				});
+				// Schedule cleanup after a short delay to ensure all events are processed
+				cleanupTimeout = setTimeout(cleanup, 1000);
+			}
+		};
+
 		if (process.stdout) {
 			process.stdout.on('data', (data: Buffer) => {
 				const output = data.toString('utf8').trim();
@@ -408,11 +466,7 @@ export class PlayerService {
 					if (output.includes('[youtube]')) {
 						if (output.includes('Post-Live Manifestless mode')) {
 							logger.info(`[Screen ${screen}] YouTube stream is in post-live state (ended)`, 'PlayerService');
-							this.errorCallback?.({
-								screen,
-								error: 'Stream ended',
-								code: 0
-							});
+							handleStreamEnd('Stream ended');
 						} else if (output.includes('Downloading MPD manifest')) {
 							logger.debug(`[Screen ${screen}] YouTube stream manifest download attempt`, 'PlayerService');
 						}
@@ -431,12 +485,7 @@ export class PlayerService {
 						output.includes('Exiting normally') ||
 						output.includes('EOF reached') ||
 						output.includes('User stopped playback')) {
-						logger.info(`Stream ended on screen ${screen}`, 'PlayerService');
-						this.errorCallback?.({
-							screen,
-							error: 'Stream ended',
-							code: 0
-						});
+						handleStreamEnd('Stream ended');
 					}
 				}
 			});
@@ -456,18 +505,10 @@ export class PlayerService {
 								`[Screen ${screen}] YouTube stream error - may be ended or unavailable: ${output}`,
 								'PlayerService'
 							);
-							this.errorCallback?.({
-								screen,
-								error: 'Stream ended',
-								code: 0
-							});
+							handleStreamEnd('Stream ended');
 						} else {
 							logger.error(`[Screen ${screen}] ${output}`, 'PlayerService');
-							this.errorCallback?.({
-								screen,
-								error: output,
-								code: 0  // Always use code 0 to trigger next stream
-							});
+							handleStreamEnd(output);
 						}
 					}
 				}
@@ -475,18 +516,18 @@ export class PlayerService {
 		}
 
 		process.on('error', (err: Error) => {
-			const errorMessage = err.message;
-			logger.error(`Process error on screen ${screen}`, 'PlayerService', errorMessage);
-			this.errorCallback?.({
-				screen,
-				error: errorMessage,
-				code: 0  // Changed to 0 to always trigger next stream
-			});
+			this.logError(`Process error on screen ${screen}`, 'PlayerService', err);
+			handleStreamEnd(err.message);
 		});
 
 		process.on('exit', (code: number | null) => {
 			logger.info(`Process exited on screen ${screen} with code ${code}`, 'PlayerService');
-			this.handleProcessExit(screen, code);
+			// Only handle process exit if we haven't already handled stream end
+			if (!hasEndedStream) {
+				handleStreamEnd('Process exited', code || 0);
+			} else {
+				cleanup();
+			}
 		});
 	}
 
@@ -577,80 +618,34 @@ export class PlayerService {
 	}
 
 	private handleProcessExit(screen: number, code: number | null): void {
-		// Clear monitoring
-		this.clearMonitoring(screen);
-
 		// Get stream options before removing the instance
 		const stream = this.streams.get(screen);
-		const streamOptions = stream?.options;
-
-		// Remove stream instance
-		this.streams.delete(screen);
-
-		// Initialize retry count if not exists
-		if (!this.streamRetries.has(screen)) {
-			this.streamRetries.set(screen, 0);
-		}
-
-		const retryCount = this.streamRetries.get(screen) || 0;
-		const MAX_RETRIES = 3;
+		
+		// Clean up resources first
+		this.cleanup_after_stop(screen);
+		
+		// Clear monitoring
+		this.clearMonitoring(screen);
 
-		// Handle different exit codes
-		if (code === 0) {
-			// Normal exit - clear retries and move to next stream
-			this.streamRetries.delete(screen);
+		// Only emit stream error if we still have a stream instance
+		// This prevents double notifications when a stream is manually stopped
+		if (stream) {
 			logger.info(
-				`Stream ended normally on screen ${screen}, moving to next stream`,
+				`Process exited on screen ${screen} with code ${code}`,
 				'PlayerService'
 			);
 			this.errorCallback?.({
 				screen,
-				error: 'Stream ended normally',
-				code: 0
+				error: code === 0 ? 'Stream ended normally' : `Stream ended with code ${code}`,
+				code: code || 0,
+				url: stream.url,
+				moveToNext: true // Always signal to move to next stream
 			});
-		} else if (code === 2) {
-			// Streamlink error (usually temporary) - retry with backoff
-			if (retryCount < MAX_RETRIES && streamOptions) {
-				const backoffTime = Math.min(1000 * Math.pow(2, retryCount), 10000); // Max 10 second backoff
-				this.streamRetries.set(screen, retryCount + 1);
-				logger.warn(
-					`Stream error on screen ${screen} (code ${code}), retry ${retryCount + 1}/${MAX_RETRIES} in ${backoffTime}ms`,
-					'PlayerService'
-				);
-				setTimeout(() => {
-					this.startStream(streamOptions).catch(error => {
-						logger.error(
-							`Failed to restart stream on screen ${screen}`,
-							'PlayerService',
-							error
-						);
-					});
-				}, backoffTime);
-			} else {
-				// Max retries reached or no options available - move to next stream
-				this.streamRetries.delete(screen);
-				logger.error(
-					`Stream failed after ${MAX_RETRIES} retries on screen ${screen}, moving to next stream`,
-					'PlayerService'
-				);
-				this.errorCallback?.({
-					screen,
-					error: `Stream failed after ${MAX_RETRIES} retries`,
-					code: -1
-				});
-			}
 		} else {
-			// Other error codes - move to next stream
-			this.streamRetries.delete(screen);
-			logger.error(
-				`Stream ended with error code ${code} on screen ${screen}, moving to next stream`,
+			logger.warn(
+				`Process exited on screen ${screen} but no stream instance found`,
 				'PlayerService'
 			);
-			this.errorCallback?.({
-				screen,
-				error: `Stream ended with error code ${code}`,
-				code: -1
-			});
 		}
 	}
 
@@ -684,22 +679,30 @@ export class PlayerService {
 	/**
 	 * Stop a stream that is currently playing on a screen
 	 */
-	async stopStream(screen: number, force: boolean = false): Promise<boolean> {
+	async stopStream(screen: number, force: boolean = false, isManualStop: boolean = false): Promise<boolean> {
 		logger.debug(`Stopping stream on screen ${screen}`, 'PlayerService');
 		
 		const player = this.streams.get(screen);
 		if (!player || !player.process) {
 			logger.debug(`No player to stop on screen ${screen}`, 'PlayerService');
+			// Clean up any resources that might be left even if no player is active
+			this.cleanup_after_stop(screen);
 			return true; // Nothing to stop, so consider it a success
 		}
 		
+		// Only track manually closed screens when it's a manual stop
+		if (isManualStop) {
+		this.manuallyClosedScreens.add(screen);
+		}
+
 		// Try graceful shutdown via IPC first
 		let gracefulShutdown = false;
 		try {
+			// Send quit command via IPC
 			await this.sendMpvCommand(screen, 'quit');
 			
-			// Give it a moment to shutdown gracefully
-			await new Promise((resolve) => setTimeout(resolve, 500));
+			// Give it a moment to shutdown gracefully (increased timeout)
+			await new Promise((resolve) => setTimeout(resolve, 1000));
 			
 			// Check if the process has exited
 			gracefulShutdown = !this.isProcessRunning(player.process.pid);
@@ -712,22 +715,43 @@ export class PlayerService {
 			logger.debug(`IPC command failed for screen ${screen}, will try force kill: ${error instanceof Error ? error.message : String(error)}`, 'PlayerService');
 		}
 		
+		// If not force but graceful shutdown worked, use normal cleanup
+		if (gracefulShutdown && !force) {
+			this.cleanup_after_stop(screen);
+			return true;
+		}
+		
 		// If graceful shutdown failed or force is true, use the forceful method
-		if (!gracefulShutdown || force) {
-			try {
-				player.process.kill('SIGTERM');
+		try {
+			// First, try to find and kill any child processes
+			this.killChildProcesses(player.process.pid);
+			
+			// Now send SIGTERM to the main process
+			player.process.kill('SIGTERM');
+			
+			// Give it a moment to respond to SIGTERM (increased timeout)
+			await new Promise((resolve) => setTimeout(resolve, 500));
+			
+			// Check if we need to force kill with SIGKILL
+			if (this.isProcessRunning(player.process.pid)) {
+				logger.debug(`SIGTERM didn't work for screen ${screen}, using SIGKILL`, 'PlayerService');
+				player.process.kill('SIGKILL');
 				
-				// Give it a moment to respond to SIGTERM
-				await new Promise((resolve) => setTimeout(resolve, 300));
+				// Give it a moment for SIGKILL to take effect
+				await new Promise((resolve) => setTimeout(resolve, 200));
 				
-				// Check if we need to force kill with SIGKILL
+				// If process still exists, try more aggressive approach with system kill command
 				if (this.isProcessRunning(player.process.pid)) {
-					logger.debug(`SIGTERM didn't work for screen ${screen}, using SIGKILL`, 'PlayerService');
-					player.process.kill('SIGKILL');
+					logger.warn(`Process for screen ${screen} resistant to SIGKILL, using system kill command`, 'PlayerService');
+					try {
+						execSync(`kill -9 ${player.process.pid}`);
+					} catch (error) {
+						this.logError(`System kill failed for screen ${screen}`, 'PlayerService', error);
+					}
 				}
-			} catch (error) {
-				logger.error(`Error killing process for screen ${screen}: ${error instanceof Error ? error.message : String(error)}`, 'PlayerService');
 			}
+		} catch (error) {
+			this.logError(`Error killing process for screen ${screen}`, 'PlayerService', error);
 		}
 		
 		// Clean up regardless of kill success
@@ -736,26 +760,116 @@ export class PlayerService {
 		return true;
 	}
 	
+	/**
+	 * Kill child processes of a given parent process
+	 */
+	private killChildProcesses(parentPid?: number): void {
+		if (!parentPid) {
+			logger.debug('No parent PID provided to kill child processes', 'PlayerService');
+			return;
+		}
+
+		try {
+			// First try to kill the parent process
+			try {
+				process.kill(parentPid, 'SIGTERM');
+				logger.debug(`Sent SIGTERM to parent process ${parentPid}`, 'PlayerService');
+			} catch (error) {
+				if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
+					logger.warn(`Error sending SIGTERM to parent process ${parentPid}`, 'PlayerService');
+				}
+			}
+
+			// Give parent process time to clean up
+			setTimeout(() => {
+				try {
+					// Check if parent is still running
+					try {
+						process.kill(parentPid, 0);
+						// If we get here, process is still running, try SIGKILL
+						process.kill(parentPid, 'SIGKILL');
+						logger.debug(`Sent SIGKILL to parent process ${parentPid}`, 'PlayerService');
+					} catch (error) {
+						if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
+							logger.warn(`Error checking/killing parent process ${parentPid}`, 'PlayerService');
+						}
+					}
+
+					// Try to get child processes
+					const childPidsStr = execSync(`pgrep -P ${parentPid}`, { encoding: 'utf8' }).trim();
+					if (childPidsStr) {
+						const childPids = childPidsStr.split('\n').map(Number);
+						for (const pid of childPids) {
+							try {
+					process.kill(pid, 'SIGTERM');
+								logger.debug(`Sent SIGTERM to child process ${pid}`, 'PlayerService');
+							} catch (error) {
+								if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
+									logger.warn(`Error killing child process ${pid}`, 'PlayerService');
+								}
+							}
+				}
+			}
+		} catch (error) {
+					// Ignore pgrep errors as the parent process might already be gone
+					if (!(error as NodeJS.ErrnoException).message?.includes('Command failed: pgrep')) {
+						const errorMsg = error instanceof Error ? error.message : String(error);
+						logger.warn(`Error killing child processes: ${errorMsg}`, 'PlayerService');
+					}
+				}
+			}, 500); // Wait 500ms before checking/killing remaining processes
+		} catch (error) {
+			const errorMsg = error instanceof Error ? error.message : String(error);
+			logger.error(`Error in killChildProcesses: ${errorMsg}`, 'PlayerService');
+		}
+	}
+	
 	/**
 	 * Clean up resources after a stream is stopped
 	 */
 	private cleanup_after_stop(screen: number): void {
-		// Clean up the monitoring interval
-		const monitorInterval = this.healthCheckIntervals.get(screen);
-		if (monitorInterval) {
-			clearInterval(monitorInterval);
-			this.healthCheckIntervals.delete(screen);
-		}
-		
-		// Clean up player state
+		try {
+			// Clear monitoring and state
+			this.clearMonitoring(screen);
+			const stream = this.streams.get(screen);
 		this.streams.delete(screen);
-		this.streamRetries.delete(screen);
-		this.streamStartTimes.delete(screen);
-		this.streamRefreshTimers.delete(screen);
-		this.inactiveTimers.delete(screen);
+		
+		// Clean up IPC socket if it exists
+		const ipcPath = this.ipcPaths.get(screen);
+		if (ipcPath && fs.existsSync(ipcPath)) {
+			try {
+				// Close any existing socket connection
+				const socket = net.createConnection(ipcPath);
+				socket.end();
+				socket.destroy();
+				
+				// Remove the socket file
+				if (fs.existsSync(ipcPath)) {
+				fs.unlinkSync(ipcPath);
+					logger.debug(`Removed IPC socket for screen ${screen}`, 'PlayerService');
+				}
+			} catch (error) {
+					// Only log as warning if file still exists
+					if (fs.existsSync(ipcPath)) {
+						const errorMsg = error instanceof Error ? error.message : String(error);
+						logger.warn(`Failed to remove IPC socket for screen ${screen}: ${errorMsg}`, 'PlayerService');
+					}
+			}
+		}
 		this.ipcPaths.delete(screen);
 		
-		logger.debug(`Cleaned up resources for screen ${screen}`, 'PlayerService');
+			// Kill any remaining processes
+			if (stream?.process?.pid) {
+				try {
+					this.killChildProcesses(stream.process.pid);
+				} catch (error) {
+					logger.debug(`Error killing processes for screen ${screen}: ${error}`, 'PlayerService');
+				}
+			}
+		} catch (error) {
+			const errorMsg = error instanceof Error ? error.message : String(error);
+			logger.error(`Error during cleanup for screen ${screen}: ${errorMsg}`, 'PlayerService');
+		}
 	}
 	
 	/**
@@ -774,127 +888,130 @@ export class PlayerService {
 		}
 	}
 
-	private getMpvArgs(options: StreamOptions & { screen: number }): string[] {
-		const screenConfig = this.config.player.screens.find((s) => s.screen === options.screen);
+	private getMpvArgs(options: StreamOptions & { screen: number }, includeUrl: boolean = true): string[] {
+		const screenConfig = this.config.player.screens.find(s => s.screen === options.screen);
 		if (!screenConfig) {
-			throw new Error(`Invalid screen number: ${options.screen}`);
+			throw new Error(`No screen configuration found for screen ${options.screen}`);
 		}
 
-		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
-		const logFile = path.join(
-			this.BASE_LOG_DIR,
-			'mpv',
-			`mpv-screen${options.screen}-${timestamp}.log`
-		);
+		// Initialize IPC path if not already set
+		if (!this.ipcPaths.has(options.screen)) {
 		const homedir = process.env.HOME || process.env.USERPROFILE;
 		const ipcPath = homedir
 			? path.join(homedir, '.livelink', `mpv-ipc-${options.screen}`)
 			: `/tmp/mpv-ipc-${options.screen}`;
 		this.ipcPaths.set(options.screen, ipcPath);
+		}
+
+		// Ensure log directory exists
+		if (!fs.existsSync(this.BASE_LOG_DIR)) {
+			fs.mkdirSync(this.BASE_LOG_DIR, { recursive: true });
+		}
 
-		// Get stream metadata for title
-		const streamTitle = options.title || 'Unknown Title';
-		const viewerCount =
-			options.viewerCount !== undefined ? `${options.viewerCount} viewers` : 'Unknown viewers';
+		const logFile = path.join(this.BASE_LOG_DIR, `screen_${options.screen}.log`);
+		const ipcPath = this.ipcPaths.get(options.screen);
 
-		// Sanitize title components to avoid issues with shell escaping
-		const sanitizedTitle = streamTitle.replace(/['"]/g, '');
+		if (!ipcPath) {
+			throw new Error(`No IPC path found for screen ${options.screen}`);
+		}
 
-		// Format the title without quotes in the argument
-		const titleArg = `--title="${sanitizedTitle} - ${viewerCount} - Screen ${options.screen}"`;
+		const baseArgs: string[] = [];
 
-		// Base arguments for MPV direct playback
-		const baseArgs = [
-			// IPC and config
-			`--input-ipc-server=${ipcPath}`,
-			`--config-dir=${this.SCRIPTS_PATH}`,
-			`--log-file=${logFile}`,
-			
-			// Window position and size
-			`--geometry=${screenConfig.width}x${screenConfig.height}+${screenConfig.x}+${screenConfig.y}`,
-			
-			// Audio settings
-			`--volume=${options.volume !== undefined ? options.volume : screenConfig.volume !== undefined ? screenConfig.volume : this.config.player.defaultVolume}`,
-			
-			// Title
-			titleArg,
-			
-			// URL must be last
-			options.url
-		];
+		// Add global MPV arguments from config
+		if (this.config.mpv) {
+			for (const [key, value] of Object.entries(this.config.mpv)) {
+				if (value !== undefined && value !== null) {
+					baseArgs.push(`--${key}=${value}`);
+				}
+			}
+		}
 
-		// Combine all arguments
-		const allArgs = [
-			...baseArgs,
-			...(options.windowMaximized || screenConfig.windowMaximized ? ['--window-maximized=yes'] : [])
-		];
+		// Add screen-specific MPV arguments from streamlink config
+		if (this.config.streamlink?.mpv) {
+			for (const [key, value] of Object.entries(this.config.streamlink.mpv)) {
+				if (value !== undefined && value !== null) {
+					baseArgs.push(`--${key}=${value}`);
+				}
+			}
+		}
+
+		// Essential arguments
+		baseArgs.push(
+			'--input-ipc-server=' + ipcPath,
+			'--config-dir=' + path.join(process.cwd(), 'scripts', 'mpv'),
+			'--log-file=' + logFile,
+			'--geometry=' + `${screenConfig.width}x${screenConfig.height}+${screenConfig.x}+${screenConfig.y}`,
+			'--volume=' + (options.volume || 0).toString(),
+			'--title=' + `${options.screen}: ${options.title || 'No Title'}`
+		);
+
+		if (options.windowMaximized) {
+			baseArgs.push('--window-maximized=yes');
+		}
+
+		// Add URL if requested
+		if (includeUrl && options.url) {
+			baseArgs.push(options.url);
+		}
 
-		return allArgs;
+		logger.debug(`MPV args for screen ${options.screen}: ${baseArgs.join(' ')}`, 'PlayerService');
+		return baseArgs;
 	}
 
 	private getStreamlinkArgs(url: string, options: StreamOptions & { screen: number }): string[] {
-		const screen = options.screen;
-		const screenConfig = this.config.player.screens.find((s) => s.screen === screen);
+		const screenConfig = this.config.player.screens.find(s => s.screen === options.screen);
 		if (!screenConfig) {
-			throw new Error(`Invalid screen number: ${screen}`);
+			throw new Error(`No screen config found for screen ${options.screen}`);
 		}
 
-		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
-		const logFile = path.join(this.BASE_LOG_DIR, 'mpv', `mpv-screen${screen}-${timestamp}.log`);
-		const homedir = process.env.HOME || process.env.USERPROFILE;
-		const ipcPath = homedir
-			? path.join(homedir, '.livelink', `mpv-ipc-${screen}`)
-			: `/tmp/mpv-ipc-${screen}`;
-		this.ipcPaths.set(screen, ipcPath);
-
-		// Get stream metadata for title
-		const streamTitle = options.title || 'Unknown Title';
-		const viewerCount =
-			options.viewerCount !== undefined ? `${options.viewerCount} viewers` : 'Unknown viewers';
-		const sanitizedTitle = streamTitle.replace(/['"]/g, '');
-		const titleArg = `--title="${sanitizedTitle} - ${viewerCount} - Screen ${options.screen}"`;
-
-		// MPV arguments specifically for Streamlink
-		const mpvArgs = [
-			// Window position and size
-			`--geometry=${screenConfig.width}x${screenConfig.height}+${screenConfig.x}+${screenConfig.y}`,
-			
-			// Audio settings
-			`--volume=${screenConfig.volume !== undefined ? screenConfig.volume : this.config.player.defaultVolume}`,
-			
-			// IPC and config
-			`--input-ipc-server=${ipcPath}`,
-			`--config-dir=${this.SCRIPTS_PATH}`,
-			`--log-file=${logFile}`,
-			
-			// Title
-			titleArg,
-			
-			// Window state
-			...(options.windowMaximized || screenConfig.windowMaximized ? ['--window-maximized=yes'] : [])
-		].filter(Boolean);
-
-		// Streamlink-specific arguments
+		// Start with streamlink-specific arguments
 		const streamlinkArgs = [
 			url,
-			'best', // Quality selection
-			...(url.includes('youtube.com') ? [
-				'--stream-segment-threads=2',  // Reduced from 3 to 2
-				'--stream-timeout=60',
-				'--hls-segment-threads=2',     // Reduced from 3 to 2
-				'--ringbuffer-size=32M',       // Limit ring buffer size
-				'--hls-segment-stream-data',   // Stream segments directly
-				'--hls-live-edge=2',          // Reduce live edge buffer
-				'--stream-segment-attempts=3', // Limit segment retry attempts
-				'--player-no-close',          // Don't close player on stream end
-				'--hls-playlist-reload-time=2' // Faster playlist reload
-			] : []),
+			options.quality || screenConfig.quality || this.config.player.defaultQuality || 'best',
 			'--player',
-			this.mpvPath,
-			'--player-args',
-			mpvArgs.join(' ')
+			this.mpvPath
 		];
 
+		// Add streamlink options from config
+		if (this.config.streamlink?.options) {
+			Object.entries(this.config.streamlink.options).forEach(([key, value]) => {
+				if (value === true) {
+					streamlinkArgs.push(`--${key}`);
+				} else if (value !== false && value !== undefined && value !== null) {
+					streamlinkArgs.push(`--${key}`, String(value));
+				}
+			});
+		}
+
+		// Add HTTP headers if configured
+		if (this.config.streamlink?.http_header) {
+			Object.entries(this.config.streamlink.http_header).forEach(([key, value]) => {
+				streamlinkArgs.push('--http-header', `${key}=${value}`);
+			});
+		}
+
+		// Get MPV arguments without the URL (we don't want streamlink to pass the URL to MPV)
+		const mpvArgs = this.getMpvArgs(options, false);
+
+		// Properly quote and escape the MPV arguments
+		const quotedMpvArgs = mpvArgs
+			.map(arg => {
+				// If arg already contains quotes, leave it as is
+				if (arg.includes('"')) return arg;
+				// If arg contains spaces, quote it
+				if (arg.includes(' ')) return `"${arg}"`;
+				return arg;
+			})
+			.join(' ');
+
+		// Add player arguments
+		streamlinkArgs.push('--player-args', quotedMpvArgs);
+
+		// Add any additional streamlink arguments from config
+		if (this.config.streamlink?.args) {
+			streamlinkArgs.push(...this.config.streamlink.args);
+		}
+
 		return streamlinkArgs;
 	}
 
@@ -931,15 +1048,11 @@ export class PlayerService {
 		try {
 			exec(`echo "${command}" | socat - ${ipcPath}`, (err) => {
 				if (err) {
-					logger.error(`Failed to send command to screen ${screen}`, 'PlayerService', err as Error);
+					this.logError(`Failed to send command to screen ${screen}`, 'PlayerService', err);
 				}
 			});
 		} catch (err) {
-			if (err instanceof Error) {
-				logger.error(`Command send error for screen ${screen}`, 'PlayerService', err);
-			} else {
-				logger.error(`Command send error for screen ${screen}`, 'PlayerService', String(err));
-			}
+			this.logError(`Command send error for screen ${screen}`, 'PlayerService', err);
 		}
 	}
 
@@ -957,6 +1070,10 @@ export class PlayerService {
 		this.errorCallback = callback;
 	}
 
+	public onStreamEnd(callback: (data: StreamEnd) => void): void {
+		this.endCallback = callback;
+	}
+
 	public handleLuaMessage(screen: number, type: string, data: Record<string, unknown>): void {
 		if (type === 'log' && typeof data.level === 'string' && typeof data.message === 'string') {
 			logger[data.level as 'debug' | 'info' | 'warn' | 'error'](
@@ -978,9 +1095,23 @@ export class PlayerService {
 		logger.info('Cleaning up player service...', 'PlayerService');
 
 		try {
-			// Stop all streams
+			// Stop all streams with force=true to ensure they're killed
 			const activeScreens = Array.from(this.streams.keys());
-			await Promise.all(activeScreens.map((screen) => this.stopStream(screen, true)));
+			
+			// Attempt graceful shutdown first
+			const promises = activeScreens.map((screen) => this.stopStream(screen, false));
+			await Promise.allSettled(promises);
+			
+			// Wait a moment for graceful shutdown to complete
+			await new Promise(resolve => setTimeout(resolve, 500));
+			
+			// Force kill any remaining streams
+			const remainingScreens = Array.from(this.streams.keys());
+			if (remainingScreens.length > 0) {
+				logger.warn(`Forcing shutdown of ${remainingScreens.length} remaining streams`, 'PlayerService');
+				const forcePromises = remainingScreens.map((screen) => this.stopStream(screen, true));
+				await Promise.allSettled(forcePromises);
+			}
 
 			// Clear all timers and state
 			activeScreens.forEach((screen) => {
@@ -994,18 +1125,25 @@ export class PlayerService {
 						fs.unlinkSync(ipcPath);
 					}
 				} catch (error) {
-					logger.warn(
-						`Failed to remove IPC socket ${ipcPath}`,
-						'PlayerService',
-						error instanceof Error ? error : new Error(String(error))
-					);
+					this.logError(`Failed to remove IPC socket ${ipcPath}`, 'PlayerService', error);
 				}
 			});
-
+			
+			// Kill any remaining streamlink processes
+			try {
+				logger.info('Checking for any remaining streamlink processes...', 'PlayerService');
+				execSync('pkill -9 streamlink || true');
+			} catch {
+				// Ignore errors, this is just a precaution
+			}
+			
+			// Reset all state
 			this.ipcPaths.clear();
 			this.streams.clear();
 			this.manuallyClosedScreens.clear();
 			this.disabledScreens.clear();
+			this.streamRetries.clear();
+			this.streamStartTimes.clear();
 
 			logger.info('Player service cleanup complete', 'PlayerService');
 		} catch (error) {
@@ -1014,6 +1152,13 @@ export class PlayerService {
 				'PlayerService',
 				error instanceof Error ? error : new Error(String(error))
 			);
+			// Even if there's an error, try to kill remaining processes
+			try {
+				execSync('pkill -9 streamlink || true');
+				execSync('pkill -9 mpv || true');
+			} catch {
+				// Ignore errors
+			}
 			throw error;
 		}
 	}
@@ -1022,68 +1167,12 @@ export class PlayerService {
 		return this.streamRetries.has(screen);
 	}
 
-	public async ensurePlayersRunning(): Promise<void> {
-		try {
-			// Check all screen configs and ensure they have players running if enabled
-			for (const screen of this.config.player.screens) {
-				// Skip if screen is disabled
-				if (!screen.enabled || this.disabledScreens.has(screen.screen) || 
-					this.manuallyClosedScreens.has(screen.screen)) {
-					logger.debug(`Skipping disabled or manually closed screen ${screen.screen}`, 'PlayerService');
-					continue;
-				}
-				
-				// Skip if a stream is already running on this screen
-				const isStreamRunning = this.streams.has(screen.screen);
-				if (isStreamRunning) {
-					continue;
-				}
-				
-				// Start a player with a dummy source
-				const options: StreamOptions & { screen: number } = {
-					url: 'about:blank', // Use about:blank as dummy source
-					screen: screen.screen,
-					quality: 'best',
-					volume: screen.volume || this.config.player.defaultVolume
-				};
-				
-				try {
-					await this.startStream(options);
-					logger.info(`Started player for screen ${screen.screen}`, 'PlayerService');
-				} catch (error) {
-					logger.error(
-						`Failed to start player for screen ${screen.screen}`,
-						'PlayerService',
-						error instanceof Error ? error : new Error(String(error))
-					);
-				}
-			}
-		} catch (error) {
-			logger.error(
-				'Failed to ensure players are running',
-				'PlayerService',
-				error instanceof Error ? error : new Error(String(error))
-			);
-		}
-	}
-
 	public disableScreen(screen: number): void {
-		logger.debug(`PlayerService: Disabling screen ${screen}`, 'PlayerService');
 		this.disabledScreens.add(screen);
-		
-		// Stop any running stream for this screen
-		this.stopStream(screen, true).catch(error => {
-			logger.error(`Failed to stop stream when disabling screen ${screen}`, 'PlayerService', error);
-		});
 	}
 
 	public enableScreen(screen: number): void {
-		logger.debug(`PlayerService: Enabling screen ${screen}`, 'PlayerService');
 		this.disabledScreens.delete(screen);
-		this.manuallyClosedScreens.delete(screen);
-		
-		// Ensure players get restarted on this screen in the next ensurePlayersRunning call
-		// We don't start it immediately to allow for proper initialization
 	}
 
 	// Helper method to extract title from URL
@@ -1118,11 +1207,7 @@ export class PlayerService {
 			const hostname = new URL(url).hostname;
 			return hostname ? `Stream from ${hostname}` : 'Unknown Stream';
 		} catch (err) {
-			logger.warn(
-				`Failed to extract title from URL: ${url}`,
-				'PlayerService',
-				err instanceof Error ? err : new Error(String(err))
-			);
+			this.logError('Failed to extract title from URL', 'PlayerService', err);
 			return 'Unknown Stream';
 		}
 	}
@@ -1132,6 +1217,7 @@ export class PlayerService {
 	 */
 	private async sendMpvCommand(screen: number, command: string): Promise<void> {
 		const ipcPath = this.ipcPaths.get(screen);
+		logger.info(`Sending command ${command} to screen ${screen} with IPC path ${ipcPath}`, 'PlayerService');
 		if (!ipcPath) {
 			logger.warn(`No IPC path found for screen ${screen}`, 'PlayerService');
 			throw new Error(`No IPC socket for screen ${screen}`);
@@ -1140,29 +1226,71 @@ export class PlayerService {
 		return new Promise((resolve, reject) => {
 			try {
 				const socket = net.createConnection(ipcPath);
+				let hasResponded = false;
+
+				// Set a shorter connection timeout
+				socket.setTimeout(500);
 				
 				socket.on('connect', () => {
 					const mpvCommand = JSON.stringify({ command: [command] });
-					socket.write(mpvCommand + '\n');
+					socket.write(mpvCommand + '\n', () => {
+						// Wait a brief moment after writing to ensure command is sent
+						setTimeout(() => {
+							if (!hasResponded) {
+								hasResponded = true;
 					socket.end();
 					resolve();
+							}
+						}, 100);
+					});
 				});
 				
 				socket.on('error', (err: Error) => {
-					logger.error(`Failed to send command to screen ${screen}`, 'PlayerService', err);
+					if (!hasResponded) {
+						hasResponded = true;
+						socket.destroy();
+						this.logError(`Failed to send command to screen ${screen}`, 'PlayerService', err);
 					reject(err);
+					}
 				});
 				
-				// Set a timeout in case the connection hangs
-				socket.setTimeout(1000, () => {
+				socket.on('timeout', () => {
+					if (!hasResponded) {
+						hasResponded = true;
 					socket.destroy();
 					logger.error(`Command send timeout for screen ${screen}`, 'PlayerService');
 					reject(new Error('Socket timeout'));
+					}
+				});
+
+				// Cleanup socket on any response
+				socket.on('data', () => {
+					if (!hasResponded) {
+						hasResponded = true;
+						socket.end();
+						resolve();
+					}
+				});
+
+				// Handle socket close
+				socket.on('close', () => {
+					if (!hasResponded) {
+						hasResponded = true;
+						reject(new Error('Socket closed unexpectedly'));
+					}
 				});
 			} catch (err) {
-				logger.error(`Command send error for screen ${screen}`, 'PlayerService', err instanceof Error ? err : String(err));
+				this.logError(`Command send error for screen ${screen}`, 'PlayerService', err instanceof Error ? err : String(err));
 				reject(err);
 			}
 		});
 	}
+
+	private logError(message: string, service: string, error: unknown): void {
+		if (error instanceof Error) {
+			logger.error(message, service, error);
+		} else {
+			logger.error(message, service, new Error(String(error)));
+		}
+	}
 }
diff --git a/src/server/services/queue_service.ts b/src/server/services/queue_service.ts
index e80e47c..9035992 100644
--- a/src/server/services/queue_service.ts
+++ b/src/server/services/queue_service.ts
@@ -8,6 +8,15 @@ export interface QueueEvents {
   'all:watched': (screen: number) => void;
 }
 
+interface FavoritesNode {
+  priority: number;
+  startTime: number;
+  currentIndex: number;
+  totalFavorites: number;
+  nextNode: FavoritesNode | null;
+  prevNode: FavoritesNode | null;
+}
+
 class QueueService extends EventEmitter {
   private queues: Map<number, StreamSource[]> = new Map();
   private watchedStreams: Set<string> = new Set();
@@ -26,21 +35,114 @@ class QueueService extends EventEmitter {
 
     // Filter out any null or undefined entries
     const validQueue = queue.filter(item => item && item.url);
+
+    // Initialize favorites tracking
+    const favorites = validQueue.filter(s => s.subtype === 'favorites')
+      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
     
-    this.queues.set(screen, validQueue);
+    // Create root node
+    const rootNode: FavoritesNode = {
+      priority: 999,
+      startTime: 0,
+      currentIndex: -1,
+      totalFavorites: favorites.length,
+      nextNode: null,
+      prevNode: null
+    };
+
+    // Build initial node chain from favorites
+    let currentNode = rootNode;
+    favorites.forEach((fav, idx) => {
+      const favTime = fav.startTime ? 
+        (typeof fav.startTime === 'string' ? new Date(fav.startTime).getTime() : fav.startTime) : 0;
+      
+      const newNode: FavoritesNode = {
+        priority: fav.priority ?? 999,
+        startTime: favTime,
+        currentIndex: idx,
+        totalFavorites: favorites.length,
+        nextNode: null,
+        prevNode: currentNode
+      };
+      currentNode.nextNode = newNode;
+      currentNode = newNode;
+    });
+
+    // Sort the queue using the node chain for comparison
+    const sortedQueue = validQueue.sort((a, b) => {
+      const aPriority = a.priority ?? 999;
+      const bPriority = b.priority ?? 999;
+      const aIsFavorite = a.subtype === 'favorites';
+      const bIsFavorite = b.subtype === 'favorites';
+
+      // If one is a favorite and the other isn't, favorite comes first
+      if (aIsFavorite && !bIsFavorite) return -1;
+      if (!aIsFavorite && bIsFavorite) return 1;
+
+      // If priorities are different, sort by priority
+      if (aPriority !== bPriority) {
+        return aPriority - bPriority;
+      }
+
+      // If both are favorites, use node chain for ordering
+      if (aIsFavorite && bIsFavorite) {
+        // Find nodes for both streams
+        let node: FavoritesNode | null = rootNode;
+        let aNode: FavoritesNode | null = null;
+        let bNode: FavoritesNode | null = null;
+
+        while (node && (!aNode || !bNode)) {
+          if (node.priority === aPriority) aNode = node;
+          if (node.priority === bPriority) bNode = node;
+          node = node.nextNode;
+        }
+
+        if (aNode && bNode) {
+          // Compare based on node order
+          return aNode.currentIndex - bNode.currentIndex;
+        }
+      }
+
+      return 0;
+    });
     
-    logger.info(`Set queue for screen ${screen}. Queue size: ${validQueue.length}`, 'QueueService');
-    logger.debug(`Queue contents: ${JSON.stringify(validQueue)}`, 'QueueService');
+    // Check if the queue has actually changed before updating and emitting events
+    const currentQueue = this.queues.get(screen) || [];
+    const hasChanged = this.hasQueueChanged(currentQueue, sortedQueue);
     
-    if (validQueue.length === 0) {
-      logger.info(`Queue for screen ${screen} is empty, emitting all:watched event`, 'QueueService');
-      this.emit('all:watched', screen);
-    } else {
-      logger.info(`Queue for screen ${screen} updated with ${validQueue.length} items`, 'QueueService');
-      this.emit('queue:updated', screen, validQueue);
+    if (hasChanged) {
+      this.queues.set(screen, sortedQueue);
+      logger.info(`Queue updated for screen ${screen}. Size: ${sortedQueue.length}`, 'QueueService');
+      
+      // Only log detailed queue info at debug level
+      logger.debug(`Queue contents for screen ${screen}: ${JSON.stringify(sortedQueue.map(s => ({
+        url: s.url,
+        priority: s.priority,
+        startTime: s.startTime,
+        viewerCount: s.viewerCount,
+        isFavorite: s.subtype === 'favorites'
+      })))}`, 'QueueService');
+      
+      if (sortedQueue.length === 0) {
+        this.emit('all:watched', screen);
+      } else {
+        this.emit('queue:updated', screen, sortedQueue);
+      }
     }
   }
 
+  private hasQueueChanged(currentQueue: StreamSource[], newQueue: StreamSource[]): boolean {
+    if (currentQueue.length !== newQueue.length) return true;
+    
+    return currentQueue.some((current, index) => {
+      const next = newQueue[index];
+      return current.url !== next.url || 
+             current.priority !== next.priority ||
+             current.viewerCount !== next.viewerCount ||
+             current.sourceStatus !== next.sourceStatus;
+    });
+  }
+
   public getQueue(screen: number): StreamSource[] {
     const queue = this.queues.get(screen) || [];
     logger.debug(`Getting queue for screen ${screen}. Queue size: ${queue.length}`, 'QueueService');
@@ -143,12 +245,32 @@ class QueueService extends EventEmitter {
   public filterUnwatchedStreams(streams: StreamSource[]): StreamSource[] {
     // First check if we have any unwatched non-favorite streams
     const hasUnwatchedNonFavorites = streams.some(stream => {
-      const isFavorite = stream.priority !== undefined && stream.priority < 900;
+      const isFavorite = stream.subtype === 'favorites';
       return !isFavorite && !this.watchedStreams.has(stream.url);
     });
 
     return streams.filter(stream => {
-      const isFavorite = stream.priority !== undefined && stream.priority < 900;
+      // Enhanced members-only detection
+      const isMembersOnly = (stream.title?.toLowerCase() || '').match(
+        /(membership|member['']?s|grembership|限定|メン限|member only)/i
+      ) !== null;
+
+      if (isMembersOnly) {
+        logger.info(`Filtering out members-only stream: ${stream.title}`, 'QueueService');
+        return false;
+      }
+
+      // Check for common error indicators in title
+      const hasErrorIndicators = (stream.title?.toLowerCase() || '').match(
+        /(unavailable|private|deleted|removed|error)/i
+      ) !== null;
+
+      if (hasErrorIndicators) {
+        logger.info(`Filtering out potentially unavailable stream: ${stream.title}`, 'QueueService');
+        return false;
+      }
+
+      const isFavorite = stream.subtype === 'favorites';
       const isWatched = this.isStreamWatched(stream.url);
       
       // If it's not watched, always include it
@@ -158,12 +280,11 @@ class QueueService extends EventEmitter {
       
       // If it's watched and a favorite, only include if all non-favorites are watched
       if (isFavorite && !hasUnwatchedNonFavorites) {
-        logger.debug(`QueueService: Including watched favorite stream ${stream.url} with priority ${stream.priority} because all non-favorites are watched`, 'QueueService');
+        logger.debug(`Including watched favorite stream ${stream.url} with priority ${stream.priority} because all non-favorites are watched`, 'QueueService');
         return true;
       }
       
-      // Otherwise, don't include watched streams
-      logger.debug(`QueueService: Filtering out watched stream ${stream.url}`, 'QueueService');
+      logger.debug(`Filtering out watched stream ${stream.url}`, 'QueueService');
       return false;
     });
   }
diff --git a/src/server/services/twitch.ts b/src/server/services/twitch.ts
index 5565b07..5403855 100644
--- a/src/server/services/twitch.ts
+++ b/src/server/services/twitch.ts
@@ -26,7 +26,6 @@ export class TwitchService implements StreamService {
     this.filters = filters;
 
     try {
-      // Initialize with client credentials flow for non-user-specific requests
       this.authProvider = new RefreshingAuthProvider({
         clientId,
         clientSecret,
@@ -47,48 +46,55 @@ export class TwitchService implements StreamService {
       const channels = options.channels || [];
       let results: StreamSource[] = [];
       
-      // If we have more than 100 channels, we need to batch the requests
-      if (channels.length > 100) {
-        logger.info(`Batching ${channels.length} channels into multiple requests (max 100 per request)`, 'TwitchService');
-        
-        // Process channels in batches of 100
+      // If we have channels to fetch
+      if (channels.length > 0) {
+        // Process channels in batches of 100 (Twitch API limit)
+        const batches: string[][] = [];
         for (let i = 0; i < channels.length; i += 100) {
           const batchChannels = channels.slice(i, i + 100);
-          logger.debug(`Processing batch ${Math.floor(i/100) + 1} with ${batchChannels.length} channels`, 'TwitchService');
-          
-          const batchStreams = await this.client.streams.getStreams({
-            userName: batchChannels,
-            language: options.language
-          });
-          
-          // Convert to StreamSource format and add to results
-          const batchResults = batchStreams.data.map(stream => ({
+          batches.push(batchChannels);
+        }
+
+        // Fetch all batches in parallel
+        const batchResults = await Promise.all(
+          batches.map(batchChannels =>
+            this.client!.streams.getStreams({
+              userName: batchChannels,
+              ...(options.language ? { language: options.language } : {})
+            }).catch(error => {
+              logger.error(
+                `Failed to fetch batch of streams: ${error instanceof Error ? error.message : String(error)}`,
+                'TwitchService'
+              );
+              return { data: [] };
+            })
+          )
+        );
+
+        // Combine all batch results
+        results = batchResults.flatMap(batch => 
+          batch.data.map(stream => ({
             url: `https://twitch.tv/${stream.userName}`,
             title: stream.title,
             platform: 'twitch' as const,
             viewerCount: stream.viewers,
             startTime: stream.startDate.getTime(),
             sourceStatus: 'live' as const,
-            channelId: stream.userName.toLowerCase() // Add channelId for sorting
-          }));
-          
-          results = [...results, ...batchResults];
-          
-          // If we've reached the desired limit, stop processing batches
-          if (limit && results.length >= limit) {
-            results = results.slice(0, limit);
-            break;
-          }
+            channelId: stream.userName.toLowerCase()
+          }))
+        );
+
+        // If we have a limit, apply it after combining all results
+        if (limit) {
+          results = results.slice(0, limit);
         }
       } else {
-        // Original logic for <= 100 channels
+        // No specific channels, just fetch by limit and language
         const streams = await this.client.streams.getStreams({
           limit,
-          userName: channels,
-          language: options.language
+          ...(options.language ? { language: options.language } : {})
         });
 
-        // Convert to StreamSource format
         results = streams.data.map(stream => ({
           url: `https://twitch.tv/${stream.userName}`,
           title: stream.title,
@@ -96,36 +102,29 @@ export class TwitchService implements StreamService {
           viewerCount: stream.viewers,
           startTime: stream.startDate.getTime(),
           sourceStatus: 'live' as const,
-          channelId: stream.userName.toLowerCase() // Add channelId for sorting
+          channelId: stream.userName.toLowerCase()
         }));
       }
 
-      // If these are favorite channels, preserve their original order
+      // If these are favorite channels, then re-sort preserving favorite order
       if (channels && channels.length > 0) {
         // Create a map of channel IDs to their original position in the favorites array
         const channelOrderMap = new Map<string, number>();
         channels.forEach((channelId, index) => {
           channelOrderMap.set(channelId.toLowerCase(), index);
         });
-        
-        // Sort streams by their channel's position in the favorites array
+
+        // Sort results based on original channel order
         results.sort((a, b) => {
-          const aOrder = a.channelId ? channelOrderMap.get(a.channelId) ?? 999 : 999;
-          const bOrder = b.channelId ? channelOrderMap.get(b.channelId) ?? 999 : 999;
+          // If either stream doesn't have a channelId, put it last
+          if (!a.channelId) return 1;
+          if (!b.channelId) return -1;
           
-          // First sort by channel order (favorites order)
-          if (aOrder !== bOrder) {
-            return aOrder - bOrder;
-          }
-          
-          // Then by viewer count for streams from the same channel
-          return (b.viewerCount || 0) - (a.viewerCount || 0);
+          const aOrder = channelOrderMap.get(a.channelId) ?? Number.MAX_SAFE_INTEGER;
+          const bOrder = channelOrderMap.get(b.channelId) ?? Number.MAX_SAFE_INTEGER;
+          return aOrder - bOrder;
         });
       }
-      // Sort by viewers if requested (for non-favorite channels)
-      else if (options.sort === 'viewers') {
-        results.sort((a, b) => (b.viewerCount || 0) - (a.viewerCount || 0));
-      }
 
       logger.info(`Found ${results.length} Twitch streams`, 'TwitchService');
       return results;
@@ -140,10 +139,65 @@ export class TwitchService implements StreamService {
   }
 
   async getVTuberStreams(limit = 50): Promise<StreamSource[]> {
-    return this.getStreams({
-      limit,
-      tags: ['VTuber']
-    });
+    if (!this.client) return [];
+
+    try {
+      // First, search for channels with VTuber tag
+      const channels = await this.client.search.searchChannels('vtuber', {
+        liveOnly: true,
+        limit
+      });
+
+      // Convert to StreamSource format
+      const results = channels.data.map(channel => ({
+        url: `https://twitch.tv/${channel.name}`,
+        title: channel.displayName,
+        platform: 'twitch' as const,
+        viewerCount: 0, // Not available in search results
+        startTime: Date.now(), // Not available in search results
+        sourceStatus: channel.isLive ? 'live' as const : 'offline' as const,
+        channelId: channel.name.toLowerCase(),
+        tags: channel.tags || []
+      }));
+
+      // Filter to only live streams with VTuber tag
+      const vtuberStreams = results.filter(stream => 
+        stream.sourceStatus === 'live' && 
+        stream.tags?.some(tag => tag.toLowerCase() === 'vtuber')
+      );
+
+      // Get actual stream data for live channels to get viewer counts
+      if (vtuberStreams.length > 0) {
+        const streamData = await this.client.streams.getStreams({
+          userName: vtuberStreams.map(s => s.channelId),
+          limit: vtuberStreams.length
+        });
+
+        // Update viewer counts and start times
+        for (const stream of streamData.data) {
+          const matchingStream = vtuberStreams.find(
+            s => s.channelId === stream.userName.toLowerCase()
+          );
+          if (matchingStream) {
+            matchingStream.viewerCount = stream.viewers;
+            matchingStream.startTime = stream.startDate.getTime();
+          }
+        }
+      }
+
+      // Sort by viewer count
+      //vtuberStreams.sort((a, b) => (b.viewerCount || 0) - (a.viewerCount || 0));
+
+      logger.info(`Found ${vtuberStreams.length} VTuber streams on Twitch`, 'TwitchService');
+      return vtuberStreams;
+    } catch (error) {
+      logger.error(
+        'Failed to get VTuber streams',
+        'TwitchService',
+        error instanceof Error ? error : new Error(String(error))
+      );
+      return [];
+    }
   }
 
   async getJapaneseStreams(limit = 50): Promise<StreamSource[]> {
@@ -205,7 +259,7 @@ export class TwitchService implements StreamService {
     }
   }
 
-  public updateFavorites(channels: string[]): void {
+  updateFavorites(channels: string[]): void {
     this.favoriteChannels = channels;
   }
 } 
\ No newline at end of file
diff --git a/src/server/stream_manager.ts b/src/server/stream_manager.ts
index d372810..cf93fcc 100644
--- a/src/server/stream_manager.ts
+++ b/src/server/stream_manager.ts
@@ -3,15 +3,16 @@ import type {
   StreamOptions, 
   PlayerSettings,
   Config,
-  StreamConfig,
   FavoriteChannels,
-  Stream
+  StreamResponse,
+  ScreenConfig
 } from '../types/stream.js';
 import type { 
   StreamOutput, 
   StreamError, 
   StreamInstance,
-  StreamResponse 
+  StreamPlatform,
+  StreamEnd
 } from '../types/stream_instance.js';
 import { logger } from './services/logger.js';
 import { loadAllConfigs } from '../config/loader.js';
@@ -25,7 +26,7 @@ import { queueService } from './services/queue_service.js';
 import fs from 'fs';
 import path from 'path';
 import { EventEmitter } from 'events';
-import { KeyboardService, keyboardEvents } from './services/keyboard_service.js';
+import { KeyboardService } from './services/keyboard_service.js';
 import './types/events.js';
 
 /**
@@ -43,6 +44,9 @@ export class StreamManager extends EventEmitter {
   private isShuttingDown = false;
   private updateInterval: NodeJS.Timeout | null = null;
   private readonly QUEUE_UPDATE_INTERVAL = 15 * 60 * 1000; // 15 minutes in milliseconds
+  private readonly STREAM_START_TIMEOUT = 30 * 1000; // 30 seconds timeout for stream start
+  private readonly QUEUE_PROCESSING_TIMEOUT = 60 * 1000; // 1 minute timeout for queue processing
+  private readonly STREAM_REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes refresh interval
   private favoriteChannels: FavoriteChannels = {
     holodex: [],
     twitch: [],
@@ -62,7 +66,10 @@ export class StreamManager extends EventEmitter {
   private readonly STREAM_CACHE_TTL = 60000; // 1 minute cache TTL
   private queueProcessing: Set<number> = new Set(); // Track screens where queue is being processed
   private lastStreamRefresh: Map<number, number> = new Map(); // Track last refresh time per screen
-  private readonly STREAM_REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes refresh interval
+  private screenConfigs: Map<number, ScreenConfig> = new Map();
+  private isOffline = false; // Added for network recovery logic
+  private queueProcessingStartTimes: Map<number, number> = new Map();
+  private queueProcessingTimeouts: Map<number, NodeJS.Timeout> = new Map();
 
   /**
    * Creates a new StreamManager instance
@@ -81,11 +88,28 @@ export class StreamManager extends EventEmitter {
     this.youtubeService = youtubeService;
     this.playerService = playerService;
     this.keyboardService = new KeyboardService();
+    this.isOffline = false; // Initialize offline state
     this.favoriteChannels = {
       holodex: config.favoriteChannels.holodex || [],
       twitch: config.favoriteChannels.twitch || [],
       youtube: config.favoriteChannels.youtube || []
     };
+    
+    // Initialize screenConfigs before other initialization that might use it
+    this.screenConfigs = new Map(config.player.screens.map(screen => [
+      screen.screen, 
+      {
+        screen: screen.screen,
+        id: screen.id,
+        enabled: screen.enabled,
+        volume: config.player.defaultVolume,
+        quality: config.player.defaultQuality,
+        windowMaximized: config.player.windowMaximized,
+        maxStreams: 1
+      }
+    ]));
+    
+    // Now that screenConfigs is initialized, we can safely initialize queues
     this.initializeQueues();
     
     // Synchronize disabled screens from config
@@ -94,404 +118,385 @@ export class StreamManager extends EventEmitter {
     logger.info('Stream manager initialized', 'StreamManager');
 
     // Handle stream end events
-    this.playerService.onStreamError(async (data) => {
-      // Don't handle retrying streams or during shutdown
-      if (this.playerService.isRetrying(data.screen) || this.isShuttingDown) {
-        return;
-      }
+    this.playerService.onStreamError(async (data: StreamError) => {
+      try {
+        // If screen was manually closed, ignore the error
+        if (this.manuallyClosedScreens.has(data.screen)) {
+          logger.info(`Screen ${data.screen} was manually closed, ignoring error`, 'StreamManager');
+          // Attempt to clean up anyway, just in case
+          this.queueProcessing.delete(data.screen);
+          this.queueProcessingStartTimes.delete(data.screen);
+          const timeout = this.queueProcessingTimeouts.get(data.screen);
+          if (timeout) {
+              clearTimeout(timeout);
+              this.queueProcessingTimeouts.delete(data.screen);
+          }
+          return;
+        }
 
-      // Check if this was a normal end (code 0) or error
-      if (data.code === 0) {
-        // Check if the error message indicates a user-initiated exit
-        const isUserExit = data.error === 'Stream ended by user' || data.error === 'Stream ended';
-        
-        if (isUserExit) {
-          logger.info(`Stream on screen ${data.screen} was ended by user, starting next stream`, 'StreamManager');
-        } else {
-          logger.info(`Stream ended normally on screen ${data.screen}, starting next stream`, 'StreamManager');
+        // Clear any existing timeouts for this screen
+        const existingTimeout = this.queueProcessingTimeouts.get(data.screen);
+        if (existingTimeout) {
+          clearTimeout(existingTimeout);
+          this.queueProcessingTimeouts.delete(data.screen);
         }
-        
-        // Always move to the next stream for normal exits or user-initiated exits
-        await this.handleStreamEnd(data.screen);
-      } else {
-        logger.error(`Stream error on screen ${data.screen}: ${data.error}`, 'StreamManager');
-        // For error cases, also try to start next stream after a delay
-        setTimeout(() => {
-          this.handleStreamEnd(data.screen).catch(error => {
-            logger.error(
-              `Failed to start next stream on screen ${data.screen}`,
-              'StreamManager',
-              error instanceof Error ? error : new Error(String(error))
-            );
-          });
-        }, 1000); // Reduced from 5000ms to 1000ms
-      }
-    });
 
-    // Start continuous queue updates
-    this.startQueueUpdates();
+        // If queue is already being processed for this screen, check how long it's been processing
+        if (this.queueProcessing.has(data.screen)) {
+          const startTime = this.queueProcessingStartTimes.get(data.screen);
+          if (startTime && Date.now() - startTime > 10000) {
+            logger.warn(`Queue processing stuck for screen ${data.screen}, resetting state`, 'StreamManager');
+            this.queueProcessing.delete(data.screen);
+            this.queueProcessingStartTimes.delete(data.screen);
+          } else {
+            logger.info(`Queue already being processed for screen ${data.screen}`, 'StreamManager');
+            return;
+          }
+        }
 
-    // Update cleanup handler
-    this.cleanupHandler = () => {
-      logger.info('Cleaning up stream processes...', 'StreamManager');
-      this.isShuttingDown = true;
-      this.stopQueueUpdates();
-      this.keyboardService.cleanup();
-      for (const [screen] of this.streams) {
-        this.stopStream(screen).catch(error => {
-          logger.error(
-            `Failed to stop stream on screen ${screen}`,
-            'StreamManager',
-            error instanceof Error ? error : new Error(String(error))
-          );
-        });
-      }
-    };
+        // Set a timeout to clear the queue processing flag if it gets stuck
+        const timeout = setTimeout(() => {
+          if (this.queueProcessing.has(data.screen)) {
+            logger.warn(`Queue processing flag stuck for screen ${data.screen}, clearing it`, 'StreamManager');
+            this.queueProcessing.delete(data.screen);
+            this.queueProcessingStartTimes.delete(data.screen);
+          }
+        }, 30000);
+
+        this.queueProcessingTimeouts.set(data.screen, timeout);
+        this.queueProcessing.add(data.screen);
+        this.queueProcessingStartTimes.set(data.screen, Date.now());
+
+        // Get the URL of the stream that actually failed
+        const failedUrl = data.url;
+        if (!failedUrl) {
+            logger.error(`Stream error event for screen ${data.screen} missing URL, cannot process queue.`, 'StreamManager');
+            // Clean up processing state and exit
+            this.queueProcessing.delete(data.screen);
+            this.queueProcessingStartTimes.delete(data.screen);
+            const timeout = this.queueProcessingTimeouts.get(data.screen);
+            if (timeout) {
+                clearTimeout(timeout);
+                this.queueProcessingTimeouts.delete(data.screen);
+            }
+            return;
+        }
 
-    // Register cleanup handlers
-    process.on('exit', this.cleanupHandler);
+        // Get the current queue from queueService *before* modification
+        let currentQueue = queueService.getQueue(data.screen);
 
-    // Set up queue event handlers
-    queueService.on('all:watched', async (screen) => {
-      if (!this.isShuttingDown) {
-        await this.handleAllStreamsWatched(screen);
-      }
-    });
+        // Find the index of the failed stream in the *current* queue
+        const failedIndex = currentQueue.findIndex((item: StreamSource) => item.url === failedUrl);
 
-    queueService.on('queue:empty', async (screen) => {
-      if (!this.isShuttingDown) {
-        await this.handleEmptyQueue(screen);
-      }
-    });
+        if (failedIndex !== -1) {
+          logger.info(`Removing failed stream ${failedUrl} from queue for screen ${data.screen}`, 'StreamManager');
+          // Remove the stream using queueService
+          queueService.removeFromQueue(data.screen, failedIndex);
+          // Update the local copy of the queue *after* removal
+          currentQueue = queueService.getQueue(data.screen);
+        } else {
+          logger.warn(`Could not find failed stream ${failedUrl} in queue for screen ${data.screen}`, 'StreamManager');
+        }
 
-    // Handle keyboard events
-    keyboardEvents.on('autostart', async (screen: number) => {
-      try {
-        await this.handleQueueEmpty(screen);
+        // Now, filter the *updated* queue
+        const screenConfig = this.getScreenConfig(data.screen);
+        const filteredQueue = screenConfig?.skipWatchedStreams
+          ? currentQueue.filter((stream: StreamSource) => !this.isStreamWatched(stream.url)) // Use updated isStreamWatched
+          : currentQueue;
+
+        if (filteredQueue.length === 0) {
+          logger.info(`No more streams in queue for screen ${data.screen} after removing failed stream and filtering`, 'StreamManager');
+          await this.handleEmptyQueue(data.screen); // handleEmptyQueue uses queueService
+          return;
+        }
+
+        // The next stream is now at index 0 of the filtered queue
+        const nextStream = filteredQueue[0];
+        if (nextStream) {
+          logger.info(`Starting next stream in queue for screen ${data.screen}: ${nextStream.url}`, 'StreamManager');
+
+          // Remove the *next* stream from the queue *before* attempting to start it
+          const nextStreamIndex = currentQueue.findIndex((item: StreamSource) => item.url === nextStream.url);
+          if (nextStreamIndex !== -1) {
+             logger.debug(`Removing next stream ${nextStream.url} from queue before starting.`, 'StreamManager');
+             queueService.removeFromQueue(data.screen, nextStreamIndex);
+          } else {
+             // This might happen if filtering removed the stream between getting currentQueue and filtering
+             logger.warn(`Could not find next stream ${nextStream.url} in current queue for removal before starting. It might have been filtered.`, 'StreamManager');
+          }
+
+          // Attempt to start the stream
+          await this.startStream({
+            url: nextStream.url,
+            screen: data.screen,
+            title: nextStream.title,
+            viewerCount: nextStream.viewerCount,
+            startTime: nextStream.startTime
+          });
+        } else {
+          // This case might occur if filtering removes all streams after removing the failed one
+          logger.info(`No suitable streams left in queue for screen ${data.screen} after filtering`, 'StreamManager');
+          await this.handleEmptyQueue(data.screen);
+        }
       } catch (error) {
-        logger.error(
-          `Failed to handle autostart for screen ${screen}`,
-          'StreamManager',
-          error instanceof Error ? error : new Error(String(error))
-        );
+        logger.error(`Error handling stream error for screen ${data.screen}:`, 'StreamManager', error instanceof Error ? error : new Error(String(error)));
+      } finally {
+        // Always clear the processing flag and timeout
+        this.queueProcessing.delete(data.screen);
+        this.queueProcessingStartTimes.delete(data.screen);
+        const timeout = this.queueProcessingTimeouts.get(data.screen);
+        if (timeout) {
+          clearTimeout(timeout);
+          this.queueProcessingTimeouts.delete(data.screen);
+        }
       }
     });
 
-    keyboardEvents.on('closeall', async () => {
+    // Set up stream end handler
+    this.playerService.onStreamEnd(async (data: StreamEnd) => {
       try {
-        const activeStreams = this.getActiveStreams();
-        await Promise.all(
-          activeStreams.map(stream => this.stopStream(stream.screen, true))
+        // Check if we're already processing this screen
+        if (this.queueProcessing.has(data.screen)) {
+          logger.info(`Already processing queue for screen ${data.screen}, skipping`, 'StreamManager');
+          return;
+        }
+
+        // Clear any existing timeouts for this screen
+        const existingTimeout = this.queueProcessingTimeouts.get(data.screen);
+        if (existingTimeout) {
+          clearTimeout(existingTimeout);
+          this.queueProcessingTimeouts.delete(data.screen);
+        }
+
+        // Set up a new timeout for this screen
+        const timeout = setTimeout(() => {
+          logger.warn(`Queue processing timeout for screen ${data.screen}, clearing state`, 'StreamManager');
+          this.queueProcessing.delete(data.screen);
+          this.queueProcessingStartTimes.delete(data.screen);
+          this.queueProcessingTimeouts.delete(data.screen);
+        }, 30000);
+        this.queueProcessingTimeouts.set(data.screen, timeout);
+        this.queueProcessing.add(data.screen);
+
+        // Get current queue and filter out watched streams based on configuration
+        const queue = this.queues.get(data.screen) || [];
+        const filteredQueue = this.filterUnwatchedStreams(queue, data.screen);
+        
+        if (filteredQueue.length === 0) {
+          logger.info(`No unwatched streams in queue for screen ${data.screen}, handling empty queue`, 'StreamManager');
+          await this.handleEmptyQueue(data.screen);
+          return;
+        }
+
+        // Get the next stream from the filtered queue
+        const nextStream = filteredQueue[0];
+        if (!nextStream) {
+          logger.info(`No next stream in filtered queue for screen ${data.screen}`, 'StreamManager');
+          await this.handleEmptyQueue(data.screen);
+          return;
+        }
+
+        // Remove the current stream from the queue if it exists
+        const currentStream = this.getActiveStreams().find((s: StreamSource) => 
+          s.screen !== undefined && s.screen === data.screen
         );
+        if (currentStream) {
+          const currentIndex = queue.findIndex((item: StreamSource) => item.url === currentStream.url);
+          if (currentIndex !== -1) {
+            logger.info(`Removing current stream ${currentStream.url} from queue`, 'StreamManager');
+            this.queues.set(data.screen, queue.filter((_, index) => index !== currentIndex));
+          }
+        }
+
+        // Start the next stream
+        logger.info(`Starting next stream in queue for screen ${data.screen}: ${nextStream.url}`, 'StreamManager');
+        await this.startStream({
+          url: nextStream.url,
+          screen: data.screen,
+          quality: this.config.player.defaultQuality,
+          title: nextStream.title,
+          viewerCount: nextStream.viewerCount,
+          startTime: nextStream.startTime
+        });
+
+        // Remove the started stream from the queue
+        const updatedQueue = queue.filter(item => item.url !== nextStream.url);
+        this.queues.set(data.screen, updatedQueue);
+
       } catch (error) {
         logger.error(
-          'Failed to close all streams',
+          `Failed to handle stream end for screen ${data.screen}`,
           'StreamManager',
           error instanceof Error ? error : new Error(String(error))
         );
+      } finally {
+        // Clean up processing state
+        const timeout = this.queueProcessingTimeouts.get(data.screen);
+        if (timeout) {
+          clearTimeout(timeout);
+          this.queueProcessingTimeouts.delete(data.screen);
+        }
+        this.queueProcessing.delete(data.screen);
       }
     });
+
+    this.initializeQueues();
+    this.startQueueUpdates();
+    this.setupNetworkRecovery();
+
+    // Initialize stream cleanup
+    this.setupStreamCleanup();
   }
 
   private async handleStreamEnd(screen: number): Promise<void> {
-    try {
-      // Check if we're already processing the queue for this screen
-      if (this.queueProcessing.has(screen)) {
-        logger.info(`Queue processing already in progress for screen ${screen}, not handling stream end`, 'StreamManager');
-        return;
+    // Clear any existing processing state
+    this.queueProcessing.delete(screen);
+    this.clearQueueProcessingTimeout(screen);
+
+    // Special handling for screen 1 - skip processing check delays
+    if (screen === 1) {
+      const nextStream = this.queues.get(screen)?.[0];
+      if (nextStream) {
+        try {
+          await this.startStream({
+            url: nextStream.url,
+            screen,
+            quality: 'best',
+            windowMaximized: true
+          });
+          return;
+        } catch (error: unknown) {
+          logger.error(
+            `Failed to start next stream on screen ${screen}`,
+            'StreamManager',
+            error instanceof Error ? error : new Error(String(error))
+          );
+        }
       }
+      return;
+    }
 
-      // Mark this screen as being processed
-      this.queueProcessing.add(screen);
-
-      // Get the current queue and log it for debugging
-      const currentQueue = queueService.getQueue(screen);
-      logger.info(`Current queue for screen ${screen} has ${currentQueue.length} items`, 'StreamManager');
-      currentQueue.forEach((item, index) => {
-        const isWatched = queueService.isStreamWatched(item.url);
-        logger.info(`  Queue item ${index}: ${item.url} (watched: ${isWatched ? 'yes' : 'no'})`, 'StreamManager');
-      });
+    // For other screens, use the normal processing logic
+    if (this.queueProcessing.has(screen)) {
+      logger.debug(`Queue already being processed for screen ${screen}`, 'StreamManager');
+      return;
+    }
 
-      // Get next stream from queue
-      const nextStream = queueService.getNextStream(screen);
-      if (!nextStream) {
-        logger.info(`No next stream in queue for screen ${screen}, fetching new streams`, 'StreamManager');
-        this.queueProcessing.delete(screen);
-        return this.handleEmptyQueue(screen);
-      }
+    this.queueProcessing.add(screen);
+    this.queueProcessingStartTimes.set(screen, Date.now());
 
-      logger.info(`Next stream in queue for screen ${screen}: ${nextStream.url}`, 'StreamManager');
-      
-      // Check if stream is already marked as watched
-      const isWatched = queueService.isStreamWatched(nextStream.url);
-      logger.info(`Stream ${nextStream.url} is${isWatched ? '' : ' not'} already marked as watched`, 'StreamManager');
-      
-      // If the stream is already watched and not a favorite, skip it
-      const isFavorite = nextStream.priority !== undefined && nextStream.priority < 900;
-      if (isWatched && !isFavorite) {
-        logger.info(`Stream ${nextStream.url} is already watched and not a favorite, skipping`, 'StreamManager');
-        // Remove from queue and try the next one
-        queueService.removeFromQueue(screen, 0);
-        this.queueProcessing.delete(screen);
-        return this.handleStreamEnd(screen);
+    try {
+      const currentStream = this.streams.get(screen);
+      if (currentStream?.url === this.playerService.DUMMY_SOURCE) {
+        logger.info(`Screen ${screen} is showing dummy black screen, attempting to start next stream`, 'StreamManager');
+        const nextStream = this.queues.get(screen)?.[0];
+        if (nextStream) {
+          await this.startStream({
+            url: nextStream.url,
+            screen,
+            quality: 'best',
+            windowMaximized: true
+          });
+          return;
+        }
       }
 
-      // Check if this stream is already playing on a higher priority screen
-      const activeStreams = this.getActiveStreams();
-      const isStreamActive = activeStreams.some(s => 
-        s.url === nextStream.url && s.screen < screen
-      );
-
-      // Always play favorite streams, even if they're playing on another screen
-      if (isStreamActive && !isFavorite) {
-        logger.info(
-          `Stream ${nextStream.url} is already playing on a higher priority screen, skipping`,
-          'StreamManager'
-        );
-        // Remove this stream from the queue and try the next one
-        queueService.removeFromQueue(screen, 0);
-        this.queueProcessing.delete(screen);
-        return this.handleStreamEnd(screen);
+      // Remove current stream from queue if it exists
+      const queue = this.queues.get(screen) || [];
+      const currentIndex = queue.findIndex(s => s.url === currentStream?.url);
+      if (currentIndex !== -1) {
+        queue.splice(currentIndex, 1);
+        this.queues.set(screen, queue);
       }
 
-      // Get screen configuration
-      const screenConfig = this.config.player.screens.find(s => s.screen === screen);
-      if (!screenConfig) {
-        logger.error(`Invalid screen number: ${screen}`, 'StreamManager');
-        this.queueProcessing.delete(screen);
+      // Get next stream from queue
+      const nextStream = queue[0];
+      if (!nextStream) {
+        await this.handleEmptyQueue(screen);
         return;
       }
 
-      // Check if the screen was manually closed by the user
-      if (this.manuallyClosedScreens.has(screen)) {
-        logger.info(`Screen ${screen} was manually closed, not starting next stream`, 'StreamManager');
-        this.queueProcessing.delete(screen);
+      // Check if stream is already watched
+      if (this.isStreamWatched(nextStream.url)) {
+        logger.info(`Stream ${nextStream.url} is already watched, skipping`, 'StreamManager');
+        queue.shift();
+        this.queues.set(screen, queue);
+        await this.handleStreamEnd(screen);
         return;
       }
 
-      // Mark as watched and remove from queue before starting the new stream
-      // This prevents the same stream from being restarted if there's an error
-      queueService.markStreamAsWatched(nextStream.url);
-      queueService.removeFromQueue(screen, 0);
-      
-      // Start the stream with metadata from the queue
-      logger.info(`Starting stream ${nextStream.url} on screen ${screen} with metadata: ${nextStream.title}, ${nextStream.viewerCount} viewers`, 'StreamManager');
-      
-      // Start the stream immediately without additional delays
+      // Start the next stream
       await this.startStream({
         url: nextStream.url,
         screen,
-        quality: screenConfig.quality || this.config.player.defaultQuality,
-        windowMaximized: screenConfig.windowMaximized,
-        volume: screenConfig.volume,
-        // Pass metadata from the queue
-        title: nextStream.title,
-        viewerCount: nextStream.viewerCount,
-        startTime: nextStream.startTime
+        quality: 'best',
+        windowMaximized: true
       });
-      
-      // Pre-fetch the next stream in the queue to prepare it
-      const upcomingStream = queueService.getNextStream(screen);
-      if (upcomingStream) {
-        // Just log that we're preparing the next stream, but don't wait for it
-        logger.info(`Preparing next stream in queue for screen ${screen}: ${upcomingStream.url}`, 'StreamManager');
-      }
-      
-      // Clear processing flag once we've started the stream
-      this.queueProcessing.delete(screen);
-    } catch (error) {
+    } catch (error: unknown) {
       logger.error(
-        `Failed to handle stream end for screen ${screen}`,
+        `Error handling stream end for screen ${screen}`,
         'StreamManager',
         error instanceof Error ? error : new Error(String(error))
       );
-      // Clear processing flag
+    } finally {
       this.queueProcessing.delete(screen);
-      // Try to handle empty queue as a fallback
-      return this.handleEmptyQueue(screen);
+      this.clearQueueProcessingTimeout(screen);
     }
   }
 
   private async handleEmptyQueue(screen: number): Promise<void> {
-    // Debounce queue processing - if already processing this screen's queue, return
-    if (this.queueProcessing.has(screen)) {
-      logger.info(`Queue processing already in progress for screen ${screen}, skipping`, 'StreamManager');
-      return;
-    }
-
-    // Check if there's already an active stream on this screen
-    const activeStream = this.getActiveStreams().find(s => s.screen === screen);
-    if (activeStream) {
-      logger.info(`Screen ${screen} already has an active stream (${activeStream.url}), not starting a new one`, 'StreamManager');
-      return;
-    }
-
-    // Mark queue as being processed
-    this.queueProcessing.add(screen);
-
     try {
-      // Get screen configuration
-      const screenConfig = this.config.player.screens.find(s => s.screen === screen);
-      if (!screenConfig) {
-        logger.warn(`Invalid screen number: ${screen}`, 'StreamManager');
-        this.queueProcessing.delete(screen);
+      // Clear any existing queue processing flag
+      this.queueProcessing.delete(screen);
+      this.queueProcessingStartTimes.delete(screen);
+      this.clearQueueProcessingTimeout(screen);
+
+      // If screen was manually closed, don't update queue
+      if (this.manuallyClosedScreens.has(screen)) {
+        logger.info(`Screen ${screen} was manually closed, not updating queue`, 'StreamManager');
         return;
       }
 
-      const now = Date.now();
-      const lastRefresh = this.lastStreamRefresh.get(screen) || 0;
-      const timeSinceLastRefresh = now - lastRefresh;
+      // Set queue processing flag with timeout
+      this.queueProcessing.add(screen);
+      this.queueProcessingStartTimes.set(screen, Date.now());
       
-      // Check if we should refresh streams
-      let allStreams = this.cachedStreams;
-      if (timeSinceLastRefresh >= this.STREAM_REFRESH_INTERVAL || allStreams.length === 0) {
-        logger.info(`Time since last refresh: ${timeSinceLastRefresh}ms, fetching new streams for screen ${screen}`, 'StreamManager');
-        this.lastStreamFetch = 0; // Reset cache to force fresh fetch
-        allStreams = await this.getLiveStreams();
-        this.lastStreamRefresh.set(screen, now);
-      } else {
-        logger.info(`Using cached streams for screen ${screen} (last refresh: ${timeSinceLastRefresh}ms ago)`, 'StreamManager');
-      }
-
-      // Check again if a stream was started while we were fetching
-      const activeStreamAfterFetch = this.getActiveStreams().find(s => s.screen === screen);
-      if (activeStreamAfterFetch) {
-        logger.info(`Screen ${screen} now has an active stream (${activeStreamAfterFetch.url}), aborting queue processing`, 'StreamManager');
+      // Set timeout for queue processing
+      const timeoutId = setTimeout(() => {
+        logger.warn(`Queue processing timed out for screen ${screen}`, 'StreamManager');
         this.queueProcessing.delete(screen);
-        return;
-      }
+        this.queueProcessingStartTimes.delete(screen);
+      }, this.QUEUE_PROCESSING_TIMEOUT);
       
-      // Filter streams for this screen
-      const availableStreams = allStreams.filter(stream => {
-        // Filter streams for this screen
-        if (stream.screen !== screen) {
-          logger.debug(`Stream ${stream.url} is assigned to screen ${stream.screen}, not ${screen}`, 'StreamManager');
-          return false;
-        }
-        
-        // Check if stream is already playing on another screen
-        const activeStreams = this.getActiveStreams();
-        const isPlaying = activeStreams.some(s => s.url === stream.url);
-        
-        // Allow high priority streams (favorites) to play on multiple screens
-        if (isPlaying && (!stream.priority || stream.priority >= 900)) {
-          logger.debug(`Stream ${stream.url} is already playing and is not high priority`, 'StreamManager');
-          return false;
-        }
-
-        // Only include streams that are actually live
-        if (stream.sourceStatus && stream.sourceStatus !== 'live') {
-          logger.debug(`Stream ${stream.url} is not live (status: ${stream.sourceStatus})`, 'StreamManager');
-          return false;
-        }
-        
-        return true;
-      });
-
-      logger.info(`Found ${availableStreams.length} streams for screen ${screen}`, 'StreamManager');
+      this.queueProcessingTimeouts.set(screen, timeoutId);
 
-      if (availableStreams.length > 0) {
-        // Sort streams by priority (lower number = higher priority)
-        const sortedStreams = availableStreams.sort((a, b) => {
-          // First by priority (undefined priority goes last)
-          const aPriority = a.priority ?? 999;
-          const bPriority = b.priority ?? 999;
-          if (aPriority !== bPriority) return aPriority - bPriority;
-          
-          // Then by viewer count for same priority
-          return 0;
-        });
-
-        // Debug: Log watched status of streams
-        sortedStreams.forEach(stream => {
-          const isWatched = queueService.isStreamWatched(stream.url);
-          logger.info(
-            `Stream ${stream.url} (priority: ${stream.priority ?? 'none'}) is${isWatched ? '' : ' not'} marked as watched`,
-            'StreamManager'
-          );
-        });
-
-        // Filter out watched streams unless all streams have been watched
-        const unwatchedStreams = queueService.filterUnwatchedStreams(sortedStreams);
-        logger.info(`After filtering: ${unwatchedStreams.length} unwatched streams available`, 'StreamManager');
-        
-        const combinedStreams = unwatchedStreams.length > 0 ? unwatchedStreams : sortedStreams;
+      // Update queue
+      await this.updateQueue(screen);
+      
+      // Clear processing flag and timeout
+      this.queueProcessing.delete(screen);
+      this.queueProcessingStartTimes.delete(screen);
+      this.clearQueueProcessingTimeout(screen);
 
-        if (combinedStreams.length > 0) {
-          const [firstStream, ...remainingStreams] = combinedStreams;
-          
-          logger.info(
-            `Starting stream ${firstStream.url} on screen ${screen} (Priority: ${firstStream.priority ?? 'none'}) with metadata: ${firstStream.title}, ${firstStream.viewerCount} viewers`,
-            'StreamManager'
-          );
-          
-          // Start first stream with all available metadata
-          await this.startStream({
-            url: firstStream.url,
-            screen: screen,
-            quality: screenConfig.quality || this.config.player.defaultQuality,
-            windowMaximized: screenConfig.windowMaximized,
-            volume: screenConfig.volume,
-            title: firstStream.title,
-            viewerCount: firstStream.viewerCount,
-            startTime: firstStream.startTime
-          });
-          
-          // Mark the stream as watched
-          queueService.markStreamAsWatched(firstStream.url);
-
-          // Queue remaining streams, maintaining priority order
-          if (remainingStreams.length > 0) {
-            queueService.setQueue(screen, remainingStreams);
-            logger.info(
-              `Queued ${remainingStreams.length} streams for screen ${screen}. ` +
-              `First in queue: ${remainingStreams[0].url} (Priority: ${remainingStreams[0].priority ?? 'none'})`,
-              'StreamManager'
-            );
-          }
-        } else {
-          logger.info(`No unwatched streams available for screen ${screen}, clearing watched history`, 'StreamManager');
-          queueService.clearWatchedStreams(); // Reset watched history to start over with high priority streams
-          return this.handleEmptyQueue(screen); // Retry with cleared history
-        }
-      } else {
-        // Check if a forced fetch was performed 
-        const wasRefreshForced = timeSinceLastRefresh >= this.STREAM_REFRESH_INTERVAL || allStreams.length === 0;
-        
-        // If we just did a fresh fetch and found nothing, schedule a retry
-        if (wasRefreshForced) {
-          logger.info(`No available streams for screen ${screen} after forced refresh, will retry in ${this.RETRY_INTERVAL}ms`, 'StreamManager');
-          queueService.clearQueue(screen);
-          // Schedule a retry after the interval
-          setTimeout(() => {
-            if (!this.isShuttingDown) {
-              this.queueProcessing.delete(screen); // Remove processing flag before retrying
-              this.handleEmptyQueue(screen).catch((error: Error | unknown) => {
-                logger.error(
-                  `Failed to retry empty queue for screen ${screen}`,
-                  'StreamManager',
-                  error instanceof Error ? error : new Error(String(error))
-                );
-              });
-            }
-          }, this.RETRY_INTERVAL);
-        } else {
-          logger.info(`No available streams for screen ${screen} in cache, will wait for next refresh interval`, 'StreamManager');
-          queueService.clearQueue(screen);
-          this.queueProcessing.delete(screen);
-        }
+      // Get updated queue
+      const queue = this.queues.get(screen) || [];
+      if (queue.length > 0) {
+        await this.handleStreamEnd(screen);
       }
     } catch (error) {
-      logger.error(
-        `Failed to handle empty queue for screen ${screen}`,
-        'StreamManager',
-        error instanceof Error ? error : new Error(String(error))
-      );
-    } finally {
-      // Remove processing flag unless we scheduled a retry
-      if (!this.isShuttingDown && this.queueProcessing.has(screen)) {
-        this.queueProcessing.delete(screen);
-      }
+      logger.error(`Error handling empty queue for screen ${screen}: ${error}`, 'StreamManager');
+      // Clear processing flag and timeout on error
+      this.queueProcessing.delete(screen);
+      this.queueProcessingStartTimes.delete(screen);
+      this.clearQueueProcessingTimeout(screen);
+    }
+  }
+
+  private clearQueueProcessingTimeout(screen: number): void {
+    const timeoutId = this.queueProcessingTimeouts.get(screen);
+    if (timeoutId) {
+      clearTimeout(timeoutId);
+      this.queueProcessingTimeouts.delete(screen);
     }
   }
 
@@ -527,72 +532,74 @@ export class StreamManager extends EventEmitter {
    * Starts a new stream on the specified screen
    */
   async startStream(options: StreamOptions & { url: string }): Promise<StreamResponse> {
-    // Find first available screen
-    let screen = options.screen;
-    if (!screen) {
-      const activeScreens = new Set(this.streams.keys());
-      for (const streamConfig of this.config.player.screens) {
-        if (!activeScreens.has(streamConfig.screen)) {
-          screen = streamConfig.screen;
-          break;
-        }
+    try {
+      // Ensure screen is defined
+      if (options.screen === undefined) {
+        return { screen: 1, success: false, message: 'Screen number is required' };
       }
-    }
+      const screen = options.screen;
 
-    if (!screen) {
-      return {
-        screen: options.screen || 1,
-        message: 'No available screens',
-        success: false
-      };
-    }
+      const stream = this.streams.get(screen);
 
-    const streamConfig = this.config.player.screens.find(s => s.screen === screen);
-    if (!streamConfig) {
-      return {
+      // If there's an existing stream, stop it first
+      if (stream) {
+        await this.stopStream(screen);
+      }
+
+      // Clear any existing processing state
+      this.queueProcessing.delete(screen);
+      this.queueProcessingStartTimes.delete(screen);
+      const timeout = this.queueProcessingTimeouts.get(screen);
+      if (timeout) {
+        clearTimeout(timeout);
+        this.queueProcessingTimeouts.delete(screen);
+      }
+
+      // Clear any existing stream from the map
+      this.streams.delete(screen);
+
+      // Start the new stream
+      const screenConfig = this.screenConfigs.get(screen);
+      if (!screenConfig) {
+        throw new Error(`Screen ${screen} not found in screenConfigs`);
+      }
+
+      const result = await this.playerService.startStream({
         screen,
-        message: `Invalid screen number: ${screen}`,
-        success: false
-      };
-    }
+        config: screenConfig,
+        url: options.url,
+        quality: options.quality || screenConfig.quality,
+        volume: options.volume || screenConfig.volume,
+        windowMaximized: options.windowMaximized ?? screenConfig.windowMaximized,
+        title: options.title,
+        viewerCount: options.viewerCount,
+        startTime: typeof options.startTime === 'string' ? Date.parse(options.startTime) : options.startTime
+      });
 
-    // Try to find stream metadata from our sources
-    let streamMetadata: Partial<StreamSource> = {};
-    
-    try {
-      // Use cached streams if available, otherwise get all live streams
-      const allStreams = this.cachedStreams.length > 0 && Date.now() - this.lastStreamFetch < this.STREAM_CACHE_TTL
-        ? this.cachedStreams
-        : await this.getLiveStreams();
-        
-      const matchingStream = allStreams.find(s => s.url === options.url);
-      
-      if (matchingStream) {
-        logger.info(`Found metadata for stream ${options.url}: ${matchingStream.title}, ${matchingStream.viewerCount} viewers`, 'StreamManager');
-        streamMetadata = matchingStream;
-      } else {
-        logger.info(`No metadata found for stream ${options.url}, using defaults`, 'StreamManager');
+      if (result.success) {
+        // Add the new stream to our map
+        this.streams.set(screen, {
+          url: options.url,
+          screen: screen,
+          quality: options.quality || 'best',
+          platform: options.url.includes('twitch.tv') ? 'twitch' as StreamPlatform : 
+                   options.url.includes('youtube.com') ? 'youtube' as StreamPlatform : 'twitch' as StreamPlatform,
+          status: 'playing',
+          volume: 100,
+          process: null,
+          id: Date.now() // Use timestamp as unique ID
+        });
       }
+
+      return { screen, success: result.success };
     } catch (error) {
-      logger.warn(`Error fetching stream metadata: ${error instanceof Error ? error.message : String(error)}`, 'StreamManager');
+      logger.error(
+        `Failed to start stream on screen ${options.screen}`,
+        'StreamManager',
+        error instanceof Error ? error : new Error(String(error))
+      );
+      return { screen: options.screen || 1, success: false };
     }
-
-    // Prepare enhanced options with metadata
-    const enhancedOptions = {
-      ...options,
-      screen,
-      quality: options.quality || streamConfig.quality,
-      volume: options.volume || streamConfig.volume,
-      windowMaximized: options.windowMaximized ?? streamConfig.windowMaximized,
-      // Use metadata if available, otherwise use provided options or defaults
-      title: options.title || streamMetadata.title,
-      viewerCount: options.viewerCount || streamMetadata.viewerCount,
-      startTime: options.startTime || streamMetadata.startTime || new Date().toLocaleTimeString()
-    };
-
-    logger.info(`Starting stream with enhanced metadata: ${enhancedOptions.title}, ${enhancedOptions.viewerCount} viewers, ${enhancedOptions.startTime}`, 'StreamManager');
-    
-    return this.playerService.startStream(enhancedOptions);
   }
 
   /**
@@ -600,67 +607,20 @@ export class StreamManager extends EventEmitter {
    */
   async stopStream(screen: number, isManualStop: boolean = false): Promise<boolean> {
     try {
-      const stream = this.streams.get(screen);
-      if (!stream) {
-        // If no active stream, emit a basic stopped state
-        this.emit('streamUpdate', {
-          screen,
-          url: '',
-          quality: '',
-          platform: 'twitch',  // Default platform
-          playerStatus: 'stopped',
-          volume: 0,
-          process: null
-        } as Stream);
-        return false;
-      }
-
-      // If manual stop, mark the screen as manually closed
       if (isManualStop) {
         this.manuallyClosedScreens.add(screen);
-        logger.info(`Screen ${screen} marked as manually closed`, 'StreamManager');
+        logger.info(`Screen ${screen} manually closed, added to manuallyClosedScreens`, 'StreamManager');
       }
 
-      // Clear any pending retries
-      this.streamRetries.delete(screen);
-      this.clearInactiveTimer(screen);
-      this.clearStreamRefresh(screen);
-
-      // Stop the stream in the player service
-      const result = await this.playerService.stopStream(screen, isManualStop);
-      
-      // Emit stopped state with stream info
-      this.emit('streamUpdate', {
-        ...stream,
-        playerStatus: 'stopped',
-        error: undefined,
-        process: null
-      } as Stream);
-
-      // Cleanup IPC/FIFO after process death
-      setTimeout(() => {
-        const fifoPath = this.fifoPaths.get(screen);
-        if (fifoPath) {
-          try { 
-            fs.unlinkSync(fifoPath); 
-          } catch {
-            // Ignore error, file may not exist
-            logger.debug(`Failed to remove FIFO file ${fifoPath}`, 'StreamManager');
-          }
-          this.fifoPaths.delete(screen);
-        }
-        this.ipcPaths.delete(screen);
-      }, 200); // Reduced from 2000ms to 500ms
-
-      this.streams.delete(screen);
-      logger.info(`Stream stopped on screen ${screen}${isManualStop ? ' (manual stop)' : ''}`, 'StreamManager');
-      return result;
+      const success = await this.playerService.stopStream(screen, false, isManualStop);
+      if (success) {
+        this.streams.delete(screen);
+        this.clearInactiveTimer(screen);
+        this.clearStreamRefresh(screen);
+      }
+      return success;
     } catch (error) {
-      logger.error(
-        'Failed to stop stream', 
-        'StreamManager', 
-        error instanceof Error ? error : new Error(String(error))
-      );
+      logger.error(`Error stopping stream on screen ${screen}: ${error}`, 'StreamManager');
       return false;
     }
   }
@@ -698,11 +658,23 @@ export class StreamManager extends EventEmitter {
       return this.cachedStreams;
     }
 
+    // If we're currently offline based on network checks, use cache and don't try to fetch
+    if (this.isOffline && this.cachedStreams.length > 0) {
+      logger.warn(`Network appears to be offline, using ${this.cachedStreams.length} cached streams instead of fetching`, 'StreamManager');
+      return this.cachedStreams;
+    }
+
     logger.info(`Fetching fresh stream data (cache expired or forced refresh)`, 'StreamManager');
     try {
       const results: Array<StreamSource & { screen?: number; sourceName?: string; priority?: number }> = [];
       const streamConfigs = this.config.streams;
       
+      // Defensive check for config
+      if (!streamConfigs || !Array.isArray(streamConfigs)) {
+        logger.warn('Stream configuration is missing or invalid', 'StreamManager');
+        return this.cachedStreams.length > 0 ? this.cachedStreams : [];
+      }
+      
       for (const streamConfig of streamConfigs) {
         const screenNumber = streamConfig.screen;
         if (!streamConfig.enabled) {
@@ -726,10 +698,27 @@ export class StreamManager extends EventEmitter {
         for (const source of sortedSources) {
           const limit = source.limit || 25;
           let streams: StreamSource[] = [];
+          let sourceSuccess = false;
+          let attemptCount = 0;
+          const MAX_SOURCE_ATTEMPTS = 2;
 
+          while (!sourceSuccess && attemptCount < MAX_SOURCE_ATTEMPTS) {
           try {
+              attemptCount++;
+              
             if (source.type === 'holodex') {
+                if (!this.holodexService) {
+                  logger.warn('Holodex service not initialized, skipping source', 'StreamManager');
+                  break;
+                }
+                
               if (source.subtype === 'favorites') {
+                  // Check that we have valid favorite channels
+                  if (!this.favoriteChannels?.holodex || !Array.isArray(this.favoriteChannels.holodex) || this.favoriteChannels.holodex.length === 0) {
+                    logger.warn('No Holodex favorite channels configured, skipping source', 'StreamManager');
+                    break;
+                  }
+                  
                 streams = await this.holodexService.getLiveStreams({
                   channels: this.favoriteChannels.holodex,
                   limit: limit,
@@ -746,33 +735,74 @@ export class StreamManager extends EventEmitter {
                 const basePriority = source.priority || 999;
                 streams.forEach(s => {
                   s.priority = basePriority - 100; // Make favorites 100 points higher priority
+                    s.screen = screenNumber; // Assign screen number
                 });
+                  
+                  sourceSuccess = true;
               } else if (source.subtype === 'organization' && source.name) {
                 streams = await this.holodexService.getLiveStreams({
                   organization: source.name,
                   limit: limit,
                   sort: 'start_scheduled'  // Sort by scheduled start time
                 });
+                  // Assign screen number and source priority to organization streams
+                  streams.forEach(s => {
+                    s.screen = screenNumber;
+                    s.priority = source.priority || 999;
+                  });
+                  
+                  sourceSuccess = true;
               }
             } else if (source.type === 'twitch') {
+                if (!this.twitchService) {
+                  logger.warn('Twitch service not initialized, skipping source', 'StreamManager');
+                  break;
+                }
+                
               if (source.subtype === 'favorites') {
+                  // Check that we have valid favorite channels
+                  if (!this.favoriteChannels?.twitch || !Array.isArray(this.favoriteChannels.twitch) || this.favoriteChannels.twitch.length === 0) {
+                    logger.warn('No Twitch favorite channels configured, skipping source', 'StreamManager');
+                    break;
+                  }
+                  
                 streams = await this.twitchService.getStreams({
                   channels: this.favoriteChannels.twitch,
                   limit: limit
                 });
-                
-                // For favorites, assign a higher priority based on source priority
-                const basePriority = source.priority || 999;
+                  // Assign screen number and source priority to Twitch favorite streams
+                  streams.forEach(s => {
+                    s.screen = screenNumber;
+                    s.priority = source.priority || 999;
+                  });
+                  
+                  sourceSuccess = true;
+                } else {
+                  streams = await this.twitchService.getStreams({
+                    tags: source.tags,
+                    limit: limit
+                  });
+                  // Assign screen number and source priority to Twitch streams
                 streams.forEach(s => {
-                  s.priority = basePriority - 100; // Make favorites 100 points higher priority
-                });
-              } else if (source.tags?.includes('vtuber')) {
-                streams = await this.twitchService.getVTuberStreams(limit);
-                // Sort VTuber streams by viewer count
-                streams.sort((a, b) => (b.viewerCount || 0) - (a.viewerCount || 0));
+                    s.screen = screenNumber;
+                    s.priority = source.priority || 999;
+                  });
+                  
+                  sourceSuccess = true;
               }
             } else if (source.type === 'youtube') {
+                if (!this.youtubeService) {
+                  logger.warn('YouTube service not initialized, skipping source', 'StreamManager');
+                  break;
+                }
+                
               if (source.subtype === 'favorites') {
+                  // Check that we have valid favorite channels
+                  if (!this.favoriteChannels?.youtube || !Array.isArray(this.favoriteChannels.youtube) || this.favoriteChannels.youtube.length === 0) {
+                    logger.warn('No YouTube favorite channels configured, skipping source', 'StreamManager');
+                    break;
+                  }
+                  
                 streams = await this.youtubeService.getLiveStreams({
                   channels: this.favoriteChannels.youtube,
                   limit
@@ -783,52 +813,93 @@ export class StreamManager extends EventEmitter {
                 streams.forEach(s => {
                   s.priority = basePriority - 100; // Make favorites 100 points higher priority
                 });
+                  
+                  sourceSuccess = true;
+                }
+              }
+              
+              // Add streams to results
+              if (streams.length > 0) {
+                results.push(...streams);
               }
-            }
-            
-            // Add source metadata to each stream
-            const streamsWithMetadata = streams.map(stream => ({
-              ...stream,
-              screen: screenNumber,
-              sourceName: `${source.type}:${source.subtype || 'other'}`,
-              // Only set priority if not already set (favorites already have priority)
-              priority: stream.priority !== undefined ? stream.priority : source.priority || 999
-            }));
-
-            results.push(...streamsWithMetadata);
           } catch (error) {
+              const errorMsg = error instanceof Error ? error.message : String(error);
+              
+              if (attemptCount < MAX_SOURCE_ATTEMPTS) {
+                logger.warn(
+                  `Failed to fetch streams for source ${source.type}:${source.subtype || 'other'} on screen ${screenNumber} (attempt ${attemptCount}/${MAX_SOURCE_ATTEMPTS}), retrying...`,
+                  'StreamManager'
+                );
+                
+                // Short delay before retry
+                await new Promise(resolve => setTimeout(resolve, 1000));
+              } else {
             logger.error(
-              `Failed to fetch streams for ${source.type}:${source.subtype || 'other'}`,
+                  `Failed to fetch streams for source ${source.type}:${source.subtype || 'other'} on screen ${screenNumber} after ${MAX_SOURCE_ATTEMPTS} attempts`,
               'StreamManager',
               error instanceof Error ? error : new Error(String(error))
             );
-            continue;
+                
+                // If this is a retry and we still failed, increment error count
+                if (retryCount > 0) {
+                  this.streamRetries.set(screenNumber, (this.streamRetries.get(screenNumber) || 0) + 1);
+                }
+                
+                // Check if error might indicate network failure
+                if (errorMsg.includes('network') || 
+                    errorMsg.includes('ECONNREFUSED') || 
+                    errorMsg.includes('ENOTFOUND') || 
+                    errorMsg.includes('timeout')) {
+                  this.isOffline = true;
+                  logger.warn('Network error detected, marking as offline', 'StreamManager');
+                }
+              }
+            }
           }
         }
       }
-      // Final sorting of all streams
-      const sortedResults = results
-      .filter(stream => stream.sourceStatus === "live")
-      .sort((a, b) => (a.priority || 999) - (b.priority || 999));
 
-      // Update cache
-      this.cachedStreams = sortedResults;
+      // Update cache if we got results (even if partial)
+      if (results.length > 0) {
       this.lastStreamFetch = now;
+        this.cachedStreams = results;
+        this.isOffline = false; // Reset offline flag if we successfully got results
+      } else if (this.cachedStreams.length > 0) {
+        // If we got no results but have cached data, use the cache and log a warning
+        logger.warn('Failed to fetch new streams, using cached streams (possible network issue)', 'StreamManager');
+        return this.cachedStreams;
+      }
 
-      return sortedResults;
+      return results;
     } catch (error) {
-      logger.error(
-        'Failed to fetch live streams',
-        'StreamManager', 
-        error instanceof Error ? error : new Error(String(error))
-      );
+      const errorMsg = error instanceof Error ? error.message : String(error);
+      logger.error('Failed to fetch live streams', 'StreamManager');
+      logger.debug(errorMsg, 'StreamManager');
+      
+      // Check if error might indicate network failure
+      if (errorMsg.includes('network') || 
+          errorMsg.includes('ECONNREFUSED') || 
+          errorMsg.includes('ENOTFOUND') || 
+          errorMsg.includes('timeout')) {
+        this.isOffline = true;
+        logger.warn('Network error detected, marking as offline', 'StreamManager');
+      }
       
+      // If we haven't exceeded max retries, try again
       if (retryCount < 3) {
-        logger.info(`Retrying getLiveStreams (attempt ${retryCount + 1})`, 'StreamManager');
-        await new Promise(resolve => setTimeout(resolve, this.RETRY_INTERVAL));
+        const retryDelay = 2000 * (retryCount + 1); // Increasing backoff
+        logger.info(`Retrying stream fetch in ${retryDelay/1000}s (attempt ${retryCount + 1}/3)`, 'StreamManager');
+        
+        await new Promise(resolve => setTimeout(resolve, retryDelay));
         return this.getLiveStreams(retryCount + 1);
       }
       
+      // Return cached streams if available, even if they're old
+      if (this.cachedStreams.length > 0) {
+        logger.warn(`Using expired cached streams (${this.cachedStreams.length} streams) after failed fetch attempts`, 'StreamManager');
+        return this.cachedStreams;
+      }
+      
       return [];
     }
   }
@@ -874,29 +945,174 @@ export class StreamManager extends EventEmitter {
       
       if (autoStartScreens.length === 0) {
         logger.info('No screens configured for auto-start', 'StreamManager');
-        
-        // Even if no auto-start screens, ensure players are running if force_player is enabled
-        await this.playerService.ensurePlayersRunning();
         return;
       }
       
       logger.info(`Auto-starting streams for screens: ${autoStartScreens.join(', ')}`, 'StreamManager');
       
-      // Reset the last refresh times for all screens to ensure a fresh start
-      autoStartScreens.forEach(screen => {
-        // Set last refresh to 0 to force initial refresh
-        this.lastStreamRefresh.set(screen, 0);
-      });
+      // First, fetch all available streams
+      const allStreams = await this.getLiveStreams();
+      logger.info(`Fetched ${allStreams.length} live streams for initialization`, 'StreamManager');
       
-      // Auto-start streams for each screen
+      // Process each screen
       for (const screen of autoStartScreens) {
-        await this.handleQueueEmpty(screen);
+        // Check if a stream is already playing on this screen
+        const activeStreams = this.getActiveStreams();
+        const isStreamActive = activeStreams.some(s => s.screen === screen);
+        
+        if (isStreamActive) {
+          logger.info(`Stream already active on screen ${screen}, skipping auto-start`, 'StreamManager');
+          
+          // Still update the queue for this screen
+          const streamConfig = this.config.streams.find(s => s.screen === screen);
+          if (!streamConfig) {
+            logger.warn(`No stream configuration found for screen ${screen}`, 'StreamManager');
+            continue;
+          }
+          
+          // Filter streams for this screen but exclude the currently playing one
+          const currentStream = this.streams.get(screen);
+          const currentUrl = currentStream?.url;
+          
+          const screenStreams = allStreams.filter(stream => {
+            // Skip the currently playing stream
+            if (currentUrl && stream.url === currentUrl) {
+              return false;
+            }
+            
+            // Only include streams that are actually live
+            if (!stream.sourceStatus || stream.sourceStatus !== 'live') {
+              return false;
+            }
+            
+            // Check if stream is already playing on another screen
+            const isPlaying = activeStreams.some(s => s.url === stream.url);
+            
+            // Never allow duplicate streams across screens
+            if (isPlaying) {
+              return false;
+            }
+            
+            // Check if this stream matches the screen's configured sources
+            const matchesSource = streamConfig.sources?.some(source => {
+              if (!source.enabled) return false;
+
+              switch (source.type) {
+                case 'holodex':
+                  if (stream.platform !== 'youtube') return false;
+                  if (source.subtype === 'favorites' && stream.channelId && this.favoriteChannels.holodex.includes(stream.channelId)) return true;
+                  if (source.subtype === 'organization' && source.name && stream.organization === source.name) return true;
+                  break;
+                case 'twitch':
+                  if (stream.platform !== 'twitch') return false;
+                  if (source.subtype === 'favorites' && stream.channelId && this.favoriteChannels.twitch.includes(stream.channelId)) return true;
+                  if (!source.subtype && source.tags?.includes('vtuber')) return true;
+                  break;
+              }
+              return false;
+            });
+
+            return matchesSource;
+          }).sort((a, b) => {
+            // Sort by priority first
+            const aPriority = a.priority ?? 999;
+            const bPriority = b.priority ?? 999;
+            if (aPriority !== bPriority) return aPriority - bPriority;
+            
+            return 0;
+          });
+          
+          // Set up the queue first
+          if (screenStreams.length > 0) {
+            queueService.setQueue(screen, screenStreams);
+            logger.info(`Initialized queue for screen ${screen} with ${screenStreams.length} streams`, 'StreamManager');
+          }
+          
+          continue; // Skip to next screen
+        }
+        
+        // Reset the last refresh time to force a fresh start
+        this.lastStreamRefresh.set(screen, 0);
+        
+        // Get stream configuration for this screen
+        const streamConfig = this.config.streams.find(s => s.screen === screen);
+        if (!streamConfig) {
+          logger.warn(`No stream configuration found for screen ${screen}`, 'StreamManager');
+          continue;
+        }
+        
+        // Filter and sort streams for this screen
+        const screenStreams = allStreams.filter(stream => {
+          // Only include streams that are actually live
+          if (!stream.sourceStatus || stream.sourceStatus !== 'live') {
+            return false;
+          }
+          
+          // Check if stream is already playing on another screen
+          const isPlaying = activeStreams.some(s => s.url === stream.url);
+          
+          // Never allow duplicate streams across screens
+          if (isPlaying) {
+            return false;
+          }
+          
+          // Check if this stream matches the screen's configured sources
+          const matchesSource = streamConfig.sources?.some(source => {
+            if (!source.enabled) return false;
+
+            switch (source.type) {
+              case 'holodex':
+                if (stream.platform !== 'youtube') return false;
+                if (source.subtype === 'favorites' && stream.channelId && this.favoriteChannels.holodex.includes(stream.channelId)) return true;
+                if (source.subtype === 'organization' && source.name && stream.organization === source.name) return true;
+                break;
+              case 'twitch':
+                if (stream.platform !== 'twitch') return false;
+                if (source.subtype === 'favorites' && stream.channelId && this.favoriteChannels.twitch.includes(stream.channelId)) return true;
+                if (!source.subtype && source.tags?.includes('vtuber')) return true;
+                break;
+            }
+            return false;
+          });
+
+          return matchesSource;
+        }).sort((a, b) => {
+          // Sort by priority first
+          const aPriority = a.priority ?? 999;
+          const bPriority = b.priority ?? 999;
+          if (aPriority !== bPriority) return aPriority - bPriority;
+          
+          return 0; //(b.viewerCount || 0) - (a.viewerCount || 0);
+        });
+        
+        if (screenStreams.length > 0) {
+          // Take the first stream to play and queue the rest
+          const [firstStream, ...queueStreams] = screenStreams;
+          
+          // Set up the queue first
+          if (queueStreams.length > 0) {
+            queueService.setQueue(screen, queueStreams);
+            logger.info(`Initialized queue for screen ${screen} with ${queueStreams.length} streams`, 'StreamManager');
+          }
+          
+          // Start playing the first stream
+          logger.info(`Starting initial stream on screen ${screen}: ${firstStream.url}`, 'StreamManager');
+          await this.startStream({
+            url: firstStream.url,
+            screen,
+            quality: this.config.player.defaultQuality,
+            windowMaximized: this.config.player.windowMaximized,
+            volume: this.config.player.defaultVolume,
+            title: firstStream.title,
+            viewerCount: firstStream.viewerCount,
+            startTime: firstStream.startTime
+          });
+        } else {
+          logger.info(`No live streams available for screen ${screen}, will try again later`, 'StreamManager');
+        }
       }
       
       logger.info('Auto-start complete', 'StreamManager');
-      
-      // Ensure players are running for all enabled screens if force_player is enabled
-      await this.playerService.ensurePlayersRunning();
     } catch (error) {
       logger.error(`Error during auto-start: ${error instanceof Error ? error.message : String(error)}`, 'StreamManager');
     }
@@ -961,21 +1177,27 @@ export class StreamManager extends EventEmitter {
   }
 
   async enableScreen(screen: number): Promise<void> {
-    const streamConfig = this.config.player.screens.find(s => s.screen === screen);
-    if (!streamConfig) {
-      throw new Error(`Invalid screen number: ${screen}`);
-    }
-    
-    streamConfig.enabled = true;
-    
-    // Notify the PlayerService that the screen is enabled
-    this.playerService.enableScreen(screen);
-    
-    logger.info(`Screen ${screen} enabled`, 'StreamManager');
-    
-    // Start streams if auto-start is enabled
-    if (this.config.player.autoStart) {
-      await this.handleEmptyQueue(screen);
+    try {
+      const config = this.getScreenConfig(screen);
+      if (!config) {
+        throw new Error(`No configuration found for screen ${screen}`);
+      }
+
+      config.enabled = true;
+      this.screenConfigs.set(screen, config);
+      await this.saveConfig();
+
+      // Remove from manually closed screens when enabling
+      this.manuallyClosedScreens.delete(screen);
+      logger.info(`Screen ${screen} enabled and removed from manuallyClosedScreens`, 'StreamManager');
+
+      // Start stream if autoStart is enabled
+      if (config.autoStart) {
+        await this.handleStreamEnd(screen);
+      }
+    } catch (error) {
+      logger.error(`Error enabling screen ${screen}: ${error}`, 'StreamManager');
+      throw error;
     }
   }
 
@@ -1156,12 +1378,7 @@ export class StreamManager extends EventEmitter {
     // Update the settings
     Object.assign(this.config.player, settings);
     
-    // If force_player was enabled, ensure players are running
-    if (settings.force_player === true) {
-      logger.info('Force player enabled, ensuring all enabled screens have players running', 'StreamManager');
-      await this.playerService.ensurePlayersRunning();
-    }
-    
+    // Emit settings update event
     this.emit('settingsUpdate', this.config.player);
     await this.saveConfig();
   }
@@ -1184,11 +1401,11 @@ export class StreamManager extends EventEmitter {
     }
   }
 
-  public getScreenConfig(screen: number): StreamConfig | undefined {
-    return this.config.player.screens.find(s => s.screen === screen);
+  public getScreenConfig(screen: number): ScreenConfig | undefined {
+    return this.screenConfigs.get(screen);
   }
 
-  public updateScreenConfig(screen: number, config: Partial<StreamConfig>): void {
+  public updateScreenConfig(screen: number, config: Partial<ScreenConfig>): void {
     const screenConfig = this.getScreenConfig(screen);
     if (!screenConfig) {
       throw new Error(`Screen ${screen} not found`);
@@ -1197,26 +1414,8 @@ export class StreamManager extends EventEmitter {
     // Update the config
     Object.assign(screenConfig, config);
     
-    // If enabling a screen and force_player is set, ensure player is running
-    if (config.enabled === true && this.config.player.force_player) {
-      const isPlayerRunning = this.playerService.getActiveStreams().some(s => s.screen === screen);
-      if (!isPlayerRunning && !this.manuallyClosedScreens.has(screen)) {
-        logger.info(`Screen ${screen} enabled with force_player active, starting player`, 'StreamManager');
-        // Start player with blank page
-        this.playerService.startStream({
-          url: 'about:blank',
-          screen,
-          quality: screenConfig.quality || this.config.player.defaultQuality,
-          volume: screenConfig.volume !== undefined ? screenConfig.volume : this.config.player.defaultVolume,
-          windowMaximized: screenConfig.windowMaximized !== undefined ? screenConfig.windowMaximized : this.config.player.windowMaximized
-        }).catch(error => {
-          logger.error(`Failed to start player for screen ${screen}: ${error instanceof Error ? error.message : String(error)}`, 'StreamManager');
-        });
-      }
-    }
-    
-    this.emit('screenUpdate', screen, screenConfig);
-    this.saveConfig();
+    this.screenConfigs.set(screen, screenConfig);
+    this.emit('screenConfigChanged', { screen, config });
   }
 
   public getConfig() {
@@ -1288,6 +1487,14 @@ export class StreamManager extends EventEmitter {
     this.config.player.screens.forEach(screen => {
       this.queues.set(screen.screen, []);
     });
+    // Force update all queues after initialization
+    this.updateAllQueues(true).catch(error => {
+      logger.error(
+        'Failed to initialize queues',
+        'StreamManager',
+        error instanceof Error ? error : new Error(String(error))
+      );
+    });
   }
 
   /**
@@ -1350,7 +1557,7 @@ export class StreamManager extends EventEmitter {
       return; // Already running
     }
 
-    const updateQueues = async () => {
+    const updateQueues = async (force: boolean = false) => {
       if (this.isShuttingDown) {
         return;
       }
@@ -1367,7 +1574,7 @@ export class StreamManager extends EventEmitter {
         try {
           // Skip screens that are already being processed
           if (this.queueProcessing.has(screen)) {
-            logger.info(`Skipping queue update for screen ${screen} - queue is being processed`, 'StreamManager');
+            logger.info(`Queue processing already in progress for screen ${screen}, skipping`, 'StreamManager');
             continue;
           }
 
@@ -1381,70 +1588,53 @@ export class StreamManager extends EventEmitter {
               const lastRefresh = this.lastStreamRefresh.get(screen) || 0;
               const timeSinceLastRefresh = now - lastRefresh;
               
-              // Only attempt to start new streams if it's been long enough since last refresh
-              if (timeSinceLastRefresh >= this.STREAM_REFRESH_INTERVAL) {
-                logger.info(`No active stream on screen ${screen} and refresh interval elapsed, fetching new streams`, 'StreamManager');
+              // Only attempt to start new streams if forced or if it's been long enough since last refresh
+              if (force || timeSinceLastRefresh >= this.STREAM_REFRESH_INTERVAL) {
+                logger.info(`No active stream on screen ${screen}, fetching new streams`, 'StreamManager');
                 // Mark as processing to prevent concurrent queue processing
                 this.queueProcessing.add(screen);
                 try {
-                  await this.handleEmptyQueue(screen);
-                } finally {
-                  this.queueProcessing.delete(screen);
-                }
-              } else {
-                logger.info(`No active stream on screen ${screen}, but refresh interval not elapsed. Skipping refresh.`, 'StreamManager');
-              }
-            } else {
-              logger.info(`Screen ${screen} was manually closed, not starting new streams`, 'StreamManager');
-            }
-          } else {
-            // If there's an active stream, just update the queue without starting new stream
-            logger.info(`Active stream on screen ${screen}, updating queue only`, 'StreamManager');
-            
-            // Only fetch new streams if the refresh interval has elapsed
-            const now = Date.now();
-            const lastRefresh = this.lastStreamRefresh.get(screen) || 0;
-            const timeSinceLastRefresh = now - lastRefresh;
-            
-            let streams = this.cachedStreams;
-            if (timeSinceLastRefresh >= this.STREAM_REFRESH_INTERVAL || streams.length === 0) {
-              logger.info(`Refresh interval elapsed for screen ${screen}, fetching new streams for queue update`, 'StreamManager');
-              streams = await this.getLiveStreams();
-              this.lastStreamRefresh.set(screen, now);
-            } else {
-              logger.info(`Using cached streams for queue update on screen ${screen} (last refresh: ${timeSinceLastRefresh}ms ago)`, 'StreamManager');
-            }
-            
+                  // Reset last stream fetch to force fresh data
+                  this.lastStreamFetch = 0;
+                  const streams = await this.getLiveStreams();
             const availableStreams = streams.filter(s => s.screen === screen);
             
             if (availableStreams.length > 0) {
-              // Get existing queue
-              const existingQueue = queueService.getQueue(screen);
-              
-              // Combine existing queue URLs with available streams
-              const existingUrls = new Set(existingQueue.map(s => s.url));
-              
-              // Add new streams that aren't in the existing queue
-              const newStreams = availableStreams.filter(s => !existingUrls.has(s.url));
-              
-              if (newStreams.length > 0) {
-                // Filter unwatched from new streams only
-                const unwatchedNewStreams = queueService.filterUnwatchedStreams(newStreams);
-                
-                if (unwatchedNewStreams.length > 0) {
-                  // Add unwatched new streams to end of existing queue
-                  const updatedQueue = [...existingQueue, ...unwatchedNewStreams];
-                  queueService.setQueue(screen, updatedQueue);
-                  logger.info(
-                    `Updated queue for screen ${screen} with ${unwatchedNewStreams.length} new streams. Total queue size: ${updatedQueue.length}`,
-                    'StreamManager'
+                    // Start first stream immediately
+                    const firstStream = availableStreams[0];
+                    await this.startStream({
+                      url: firstStream.url,
+                      screen,
+                      quality: this.config.player.defaultQuality,
+                      title: firstStream.title,
+                      viewerCount: firstStream.viewerCount,
+                      startTime: firstStream.startTime
+                    });
+                    
+                    // Set remaining streams in queue
+                    if (availableStreams.length > 1) {
+                      queueService.setQueue(screen, availableStreams.slice(1));
+                    }
+                    
+                    this.lastStreamRefresh.set(screen, now);
+                  } else {
+                    logger.info(`No available streams found for screen ${screen}`, 'StreamManager');
+                  }
+                } catch (error) {
+                  logger.error(
+                    `Failed to fetch streams for screen ${screen}`,
+                    'StreamManager',
+                    error instanceof Error ? error : new Error(String(error))
                   );
+                } finally {
+                  // Always clear the processing flag
+                  this.queueProcessing.delete(screen);
+                }
                 } else {
-                  logger.info(`No new unwatched streams for screen ${screen}`, 'StreamManager');
+                logger.info(`No active stream on screen ${screen}, but refresh interval not elapsed. Skipping refresh.`, 'StreamManager');
                 }
               } else {
-                logger.info(`No new streams available for screen ${screen}`, 'StreamManager');
-              }
+              logger.info(`Screen ${screen} was manually closed, not starting new streams`, 'StreamManager');
             }
           }
         } catch (error) {
@@ -1453,12 +1643,14 @@ export class StreamManager extends EventEmitter {
             'StreamManager',
             error instanceof Error ? error : new Error(String(error))
           );
+          // Ensure processing flag is cleared on error
+          this.queueProcessing.delete(screen);
         }
       }
     };
 
     // Initial update
-    await updateQueues();
+    await updateQueues(true); // Force initial update
 
     // Set up interval for periodic updates
     this.updateInterval = setInterval(async () => {
@@ -1569,88 +1761,33 @@ export class StreamManager extends EventEmitter {
    * @param screen Screen number
    * @param forceRefresh Whether to force a refresh regardless of time elapsed
    */
-  async updateQueue(screen: number, forceRefresh = false): Promise<void> {
-    if (this.isShuttingDown) {
-      return;
-    }
+  async updateQueue(screen: number): Promise<void> {
+    try {
+      const screenConfig = this.getScreenConfig(screen);
+      if (!screenConfig || !screenConfig.enabled) {
+        logger.debug(`Screen ${screen} is disabled or has no config, skipping queue update`, 'StreamManager');
+        return;
+      }
 
-    // Skip screens that are already being processed
-    if (this.queueProcessing.has(screen)) {
-      logger.info(`Skipping queue update for screen ${screen} - queue is being processed`, 'StreamManager');
-      return;
-    }
+      // Get streams from all sources
+      const streams = await this.getAllStreamsForScreen(screen);
+      
+      // Filter out watched streams based on configuration
+      const filteredStreams = this.filterUnwatchedStreams(streams, screen);
 
-    try {
-      // Check if there's an active stream on this screen
-      const activeStream = this.getActiveStreams().find(s => s.screen === screen);
+      // Sort streams
+      const sortedStreams = this.sortStreams(filteredStreams, screenConfig.sorting);
+
+      // Update queue
+      this.queues.set(screen, sortedStreams);
       
-      if (forceRefresh) {
-        // Force refresh - set last refresh to 0 to ensure new data is fetched
-        this.lastStreamRefresh.set(screen, 0);
-        logger.info(`Forcing refresh for screen ${screen}`, 'StreamManager');
-        
-        // If no active stream and not manually closed, try to start a new one
-        if (!activeStream && !this.manuallyClosedScreens.has(screen)) {
-          // Mark as processing to prevent concurrent queue processing
-          this.queueProcessing.add(screen);
-          try {
-            await this.handleEmptyQueue(screen);
-          } finally {
-            this.queueProcessing.delete(screen);
-          }
-        } else if (activeStream) {
-          // If active stream, just update the queue
-          logger.info(`Active stream on screen ${screen}, updating queue only`, 'StreamManager');
-          
-          // Fetch fresh streams
-          const streams = await this.getLiveStreams();
-          this.lastStreamRefresh.set(screen, Date.now());
-          
-          const availableStreams = streams.filter(s => s.screen === screen);
-          
-          if (availableStreams.length > 0) {
-            // Get existing queue
-            const existingQueue = queueService.getQueue(screen);
-            
-            // Combine existing queue URLs with available streams
-            const existingUrls = new Set(existingQueue.map(s => s.url));
-            
-            // Add new streams that aren't in the existing queue
-            const newStreams = availableStreams.filter(s => !existingUrls.has(s.url));
-            
-            if (newStreams.length > 0) {
-              // Filter unwatched from new streams only
-              const unwatchedNewStreams = queueService.filterUnwatchedStreams(newStreams);
-              
-              if (unwatchedNewStreams.length > 0) {
-                // Add unwatched new streams to end of existing queue
-                const updatedQueue = [...existingQueue, ...unwatchedNewStreams];
-                queueService.setQueue(screen, updatedQueue);
-                logger.info(
-                  `Updated queue for screen ${screen} with ${unwatchedNewStreams.length} new streams. Total queue size: ${updatedQueue.length}`,
-                  'StreamManager'
-                );
-              } else {
-                logger.info(`No new unwatched streams for screen ${screen}`, 'StreamManager');
-              }
-            } else {
-              logger.info(`No new streams available for screen ${screen}`, 'StreamManager');
-            }
-          }
-        }
-      } else {
-        // Non-forced update - follow normal refresh interval
-        const now = Date.now();
-        const lastRefresh = this.lastStreamRefresh.get(screen) || 0;
-        const timeSinceLastRefresh = now - lastRefresh;
-        
-        if (timeSinceLastRefresh >= this.STREAM_REFRESH_INTERVAL) {
-          logger.info(`Refresh interval elapsed for screen ${screen}, updating queue`, 'StreamManager');
-          await this.updateQueue(screen, true);
-        } else {
-          logger.info(`Refresh interval not elapsed for screen ${screen}, skipping queue update`, 'StreamManager');
-        }
-      }
+      logger.info(
+        `Updated queue for screen ${screen}: ${sortedStreams.length} streams (${streams.length - sortedStreams.length} filtered)`,
+        'StreamManager'
+      );
+
+      // Emit queue update event
+      this.emit('queueUpdate', { screen, queue: sortedStreams });
     } catch (error) {
       logger.error(
         `Failed to update queue for screen ${screen}`,
@@ -1660,6 +1797,50 @@ export class StreamManager extends EventEmitter {
     }
   }
 
+  private filterUnwatchedStreams(streams: StreamSource[], screen: number): StreamSource[] {
+    // Get screen config
+    const screenConfig = this.getScreenConfig(screen);
+    if (!screenConfig) {
+      logger.warn(`No config found for screen ${screen}, using default settings`, 'StreamManager');
+    }
+
+    // Check if we should skip watched streams
+    // First check screen-specific setting, then global setting, default to true if neither is set
+    const skipWatched = screenConfig?.skipWatchedStreams !== undefined ? 
+      screenConfig.skipWatchedStreams : 
+      (this.config.skipWatchedStreams !== undefined ? this.config.skipWatchedStreams : true);
+
+    if (!skipWatched) {
+      logger.info(`Watched stream skipping disabled for screen ${screen}`, 'StreamManager');
+      return streams;
+    }
+
+    const unwatchedStreams = streams.filter((stream: StreamSource) => {
+      const isWatched = this.isStreamWatched(stream.url);
+      if (isWatched) {
+        logger.debug(
+          `Filtering out watched stream: ${stream.url} (${stream.title || 'No title'})`,
+          'StreamManager'
+        );
+      }
+      return !isWatched;
+    });
+
+    if (unwatchedStreams.length < streams.length) {
+      logger.info(
+        `Filtered out ${streams.length - unwatchedStreams.length} watched streams for screen ${screen}`,
+        'StreamManager'
+      );
+    }
+
+    return unwatchedStreams;
+  }
+
+  private isStreamWatched(url: string): boolean {
+    // Use queueService to check watched status
+    return queueService.getWatchedStreams().includes(url);
+  }
+
   /**
    * Updates all queues for enabled screens
    * @param forceRefresh Whether to force a refresh for all screens
@@ -1676,7 +1857,7 @@ export class StreamManager extends EventEmitter {
 
     // Update queues for each screen
     for (const screen of enabledScreens) {
-      await this.updateQueue(screen, forceRefresh);
+      await this.updateQueue(screen);
     }
   }
 
@@ -1694,6 +1875,254 @@ export class StreamManager extends EventEmitter {
       }
     }
   }
+
+  // Add method to force queue refresh
+  public async forceQueueRefresh(): Promise<void> {
+    logger.info('Forcing queue refresh for all screens', 'StreamManager');
+    // Reset all refresh timestamps to force update
+    this.lastStreamFetch = 0;
+    for (const screen of this.getEnabledScreens()) {
+      this.lastStreamRefresh.set(screen, 0);
+    }
+    // Clear any existing queues
+    queueService.clearAllQueues();
+    // Force update all queues
+    await this.updateAllQueues(true);
+  }
+
+  // Add network recovery handler
+  private setupNetworkRecovery(): void {
+    let wasOffline = false;
+    let recoveryAttempts = 0;
+    const RECOVERY_DELAY = 5000; // 5 seconds between recovery attempts
+    
+    const CHECK_URLS = [
+      'https://8.8.8.8',
+      'https://1.1.1.1',
+      'https://google.com',
+      'https://cloudflare.com'
+    ];
+
+    // Check network status periodically
+    setInterval(async () => {
+      try {
+        // Try each URL until one succeeds
+        let isOnline = false;
+        for (const url of CHECK_URLS) {
+          try {
+            const controller = new AbortController();
+            const timeoutId = setTimeout(() => controller.abort(), 3000); // 3s timeout
+            
+            const response = await fetch(url, { 
+              signal: controller.signal,
+              method: 'HEAD'  // Only request headers, not full content
+            });
+            clearTimeout(timeoutId);
+            
+            if (response.ok) {
+              isOnline = true;
+              break;
+            }
+          } catch {
+            // Continue to next URL if this one fails
+            continue;
+          }
+        }
+
+        if (!isOnline && !wasOffline) {
+          // Just went offline
+          wasOffline = true;
+          recoveryAttempts = 0;
+          logger.warn('Network connection lost - unable to reach any test endpoints', 'StreamManager');
+        } else if (isOnline && wasOffline) {
+          // Just came back online
+          wasOffline = false;
+          recoveryAttempts = 0;
+          logger.info('Network connection restored, refreshing streams', 'StreamManager');
+          
+          // Execute recovery with delay to ensure network is stable
+          setTimeout(async () => {
+            try {
+              // First, ensure all essential properties are initialized
+              if (!this.screenConfigs) {
+                logger.warn('Reinitializing screenConfigs after network outage', 'StreamManager');
+                this.screenConfigs = new Map(this.config.player.screens.map(screen => [
+                  screen.screen,
+                  {
+                    screen: screen.screen,
+                    id: screen.id || screen.screen,
+                    enabled: screen.enabled,
+                    volume: screen.volume || this.config.player.defaultVolume,
+                    quality: screen.quality || this.config.player.defaultQuality,
+                    windowMaximized: screen.windowMaximized ?? this.config.player.windowMaximized,
+                    sources: [],
+                    sorting: { field: 'viewerCount', order: 'desc' },
+                    refresh: 300,
+                    autoStart: true
+                  }
+                ]));
+              }
+              
+              // Force refresh all queues and streams
+              await this.forceQueueRefresh();
+              
+              // Check active streams and restart any that might have failed during outage
+              const activeStreams = this.getActiveStreams();
+              logger.info(`Checking ${activeStreams.length} active streams after network recovery`, 'StreamManager');
+              
+              // For screens without active streams, try to start next in queue
+              const enabledScreens = this.getEnabledScreens();
+              for (const screen of enabledScreens) {
+                const hasActiveStream = activeStreams.some((s: StreamSource) => 
+                  s.screen !== undefined && s.screen === screen
+                );
+                if (!hasActiveStream && !this.manuallyClosedScreens.has(screen)) {
+                  logger.info(`No active stream on screen ${screen} after network recovery, attempting to start next stream`, 'StreamManager');
+                  await this.handleEmptyQueue(screen);
+                }
+              }
+            } catch (error) {
+              logger.error('Failed to execute network recovery actions', 'StreamManager', 
+                error instanceof Error ? error : new Error(String(error))
+              );
+            }
+          }, RECOVERY_DELAY);
+        } else if (!isOnline && wasOffline) {
+          // Still offline
+          recoveryAttempts++;
+          if (recoveryAttempts % 6 === 0) { // Log every ~60 seconds (6 * 10s interval)
+            logger.warn(`Network still disconnected. Recovery will be attempted when connection is restored.`, 'StreamManager');
+          }
+        }
+      } catch (error) {
+        if (!wasOffline) {
+          wasOffline = true;
+          recoveryAttempts = 0;
+          logger.warn(
+            'Network connection lost', 
+            'StreamManager',
+            error instanceof Error ? error.message : String(error)
+          );
+        }
+      }
+    }, 10000); // Check every 10 seconds
+  }
+
+  async refreshStreams(): Promise<void> {
+    logger.info('Refreshing streams for all screens', 'StreamManager');
+    for (const screen of this.screenConfigs.keys()) {
+        await this.updateQueue(screen);
+    }
+  }
+
+  // Add a method to periodically clean up finished streams
+  private setupStreamCleanup(): void {
+    setInterval(() => {
+      const activeStreams = this.playerService.getActiveStreams();
+      const activeScreens = new Set(activeStreams
+        .filter((s: StreamSource) => s.screen !== undefined)
+        .map((s: StreamSource) => s.screen));
+      
+      // Remove any streams that are no longer active
+      for (const [screen] of this.streams.entries()) {
+        if (!activeScreens.has(screen)) {
+          logger.info(`Cleaning up finished stream on screen ${screen}`, 'StreamManager');
+          this.streams.delete(screen);
+          this.queueProcessing.delete(screen);
+          this.queueProcessingStartTimes.delete(screen);
+          const timeout = this.queueProcessingTimeouts.get(screen);
+          if (timeout) {
+            clearTimeout(timeout);
+            this.queueProcessingTimeouts.delete(screen);
+          }
+        }
+      }
+    }, 5000); // Check every 5 seconds
+  }
+
+  private async getAllStreamsForScreen(screen: number): Promise<StreamSource[]> {
+    const screenConfig = this.getScreenConfig(screen);
+    if (!screenConfig || !screenConfig.sources?.length) {
+      return [];
+    }
+
+    const streams: StreamSource[] = [];
+    for (const source of screenConfig.sources) {
+      if (!source.enabled) continue;
+
+      try {
+        let sourceStreams: StreamSource[] = [];
+        if (source.type === 'holodex') {
+          if (source.subtype === 'organization' && source.name) {
+            sourceStreams = await this.holodexService.getLiveStreams({
+              organization: source.name,
+              limit: source.limit
+            });
+          } else if (source.subtype === 'favorites') {
+            sourceStreams = await this.holodexService.getLiveStreams({
+              channels: this.config.favoriteChannels.holodex,
+              limit: source.limit
+            });
+          }
+        } else if (source.type === 'twitch') {
+          if (source.subtype === 'favorites') {
+            sourceStreams = await this.twitchService.getStreams({
+              channels: this.config.favoriteChannels.twitch,
+              limit: source.limit
+            });
+          }
+        }
+
+        // Add source metadata to streams
+        sourceStreams.forEach(stream => {
+          stream.subtype = source.subtype;
+          stream.priority = source.priority;
+        });
+
+        streams.push(...sourceStreams);
+      } catch (error) {
+        logger.error(
+          `Failed to fetch streams for source ${source.type}/${source.subtype}`,
+          'StreamManager',
+          error instanceof Error ? error : new Error(String(error))
+        );
+      }
+    }
+
+    return streams;
+  }
+
+  private sortStreams(streams: StreamSource[], sorting?: { field: string; order: 'asc' | 'desc' }): StreamSource[] {
+    if (!sorting) return streams;
+
+    return [...streams].sort((a, b) => {
+      let comparison = 0;
+
+      // First sort by priority if available
+      if (a.priority !== undefined && b.priority !== undefined) {
+        comparison = a.priority - b.priority;
+        if (comparison !== 0) return comparison;
+      }
+
+      // Then sort by the specified field
+      switch (sorting.field) {
+        case 'viewerCount': {
+          comparison = (b.viewerCount || 0) - (a.viewerCount || 0);
+          break;
+        }
+        case 'startTime': {
+          const aTime = a.startTime ? new Date(a.startTime).getTime() : 0;
+          const bTime = b.startTime ? new Date(b.startTime).getTime() : 0;
+          comparison = aTime - bTime;
+          break;
+        }
+        default:
+          return 0;
+      }
+
+      return sorting.order === 'desc' ? comparison : -comparison;
+    });
+  }
 }
 
 // Create singleton instance
@@ -1712,7 +2141,7 @@ const twitchService = new TwitchService(
 const youtubeService = new YouTubeService(
   config.favoriteChannels.youtube
 );
-const playerService = new PlayerService();
+const playerService = new PlayerService(config);
 
 export const streamManager = new StreamManager(
   config,
diff --git a/src/server/workers/player_worker.ts b/src/server/workers/player_worker.ts
index cd78a8d..bb18723 100644
--- a/src/server/workers/player_worker.ts
+++ b/src/server/workers/player_worker.ts
@@ -1,5 +1,6 @@
 import { isMainThread, parentPort, workerData } from 'worker_threads';
 import { PlayerService } from '../services/player.js';
+import { loadAllConfigs } from '../../config/loader.js';
 import type { 
   WorkerMessage, 
   WorkerResponse
@@ -11,7 +12,11 @@ import type {
 import { logger } from '../services/logger.js';
 
 if (!isMainThread) {
-  const player = new PlayerService();
+  // Load config
+  const config = loadAllConfigs();
+
+  // Initialize player service with config
+  const player = new PlayerService(config);
   const { streamId } = workerData;
   
   parentPort?.on('message', async (message: WorkerMessage) => {
@@ -21,7 +26,19 @@ if (!isMainThread) {
           const { screen, ...options } = message.data;
           const result = await player.startStream({
             ...options,
-            screen: screen || streamId // Use streamId as fallback
+            screen: screen || streamId, // Use streamId as fallback
+            config: {
+              screen: screen || streamId,
+              id: screen || streamId,
+              enabled: true,
+              volume: options.volume || 50,
+              quality: options.quality || 'best',
+              windowMaximized: options.windowMaximized || false,
+              sources: [],
+              sorting: { field: 'viewerCount', order: 'desc' },
+              refresh: 300,
+              autoStart: true
+            }
           });
           parentPort?.postMessage({ 
             type: 'startResult', 
diff --git a/src/types/stream.ts b/src/types/stream.ts
index 18b6522..74a2398 100644
--- a/src/types/stream.ts
+++ b/src/types/stream.ts
@@ -465,71 +465,4 @@ export interface StreamError {
 export interface StreamEnd {
   screen: string;
   url: string;
-}
-
-export interface StreamConfig {
-  /** Screen identifier */
-  screen: number;
-  /** Screen ID */
-  id: number;
-  /** Whether this screen is enabled */
-  enabled: boolean;
-  /** Whether to skip streams that have been watched */
-  skipWatchedStreams?: boolean;
-  /** Default volume level (0-100) */
-  volume: number;
-  /** Default quality setting */
-  quality: string;
-  /** Whether the window should be maximized */
-  windowMaximized: boolean;
-  /** Player type to use for this screen (streamlink or mpv) */
-  playerType?: 'streamlink' | 'mpv' | 'both';
-  /** X position of the window */
-  windowX?: number;
-  /** Y position of the window */
-  windowY?: number;
-  /** Width of the window */
-  windowWidth?: number;
-  /** Height of the window */
-  windowHeight?: number;
-  /** Width of the screen */
-  width?: number;
-  /** Height of the screen */
-  height?: number;
-  /** X position of the screen */
-  x?: number;
-  /** Y position of the screen */
-  y?: number;
-  /** Whether this is the primary screen */
-  primary?: boolean;
-  /** Stream sources for this screen */
-  sources?: Array<{
-    /** Source type (holodex, twitch, youtube) */
-    type: string;
-    /** Source subtype (favorites, organization, etc.) */
-    subtype?: string;
-    /** Whether this source is enabled */
-    enabled: boolean;
-    /** Priority of this source (lower number = higher priority) */
-    priority?: number;
-    /** Maximum number of streams to fetch */
-    limit?: number;
-    /** Name of the organization (for holodex) */
-    name?: string;
-    /** Tags to filter by */
-    tags?: string[];
-  }>;
-  /** Sorting configuration */
-  sorting?: {
-    /** Field to sort by */
-    field: string;
-    /** Sort order */
-    order: 'asc' | 'desc';
-  };
-  /** Refresh interval in seconds */
-  refresh?: number;
-  /** Whether to auto-start streams on this screen */
-  autoStart?: boolean;
-  /** Additional screen-specific settings */
-  [key: string]: unknown;
 } 
\ No newline at end of file
