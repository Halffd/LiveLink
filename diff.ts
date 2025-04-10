diff --git a/src/server/routes/api.ts b/src/server/routes/api.ts
index 1ea6fbf..f336fd5 100644
--- a/src/server/routes/api.ts
+++ b/src/server/routes/api.ts
@@ -277,7 +277,7 @@ router.post('/api/streams/queue/:screen', async (ctx: Context) => {
     const source: StreamSource = {
       url: body.url,
       title: body.title,
-      platform: body.platform
+      platform: body.platform as 'youtube' | 'twitch' | undefined
     };
 
     await streamManager.addToQueue(screen, source);
diff --git a/src/types/stream.ts b/src/types/stream.ts
index 74a2398..18b6522 100644
--- a/src/types/stream.ts
+++ b/src/types/stream.ts
@@ -465,4 +465,71 @@ export interface StreamError {
 export interface StreamEnd {
   screen: string;
   url: string;
+}
+
+export interface StreamConfig {
+  /** Screen identifier */
+  screen: number;
+  /** Screen ID */
+  id: number;
+  /** Whether this screen is enabled */
+  enabled: boolean;
+  /** Whether to skip streams that have been watched */
+  skipWatchedStreams?: boolean;
+  /** Default volume level (0-100) */
+  volume: number;
+  /** Default quality setting */
+  quality: string;
+  /** Whether the window should be maximized */
+  windowMaximized: boolean;
+  /** Player type to use for this screen (streamlink or mpv) */
+  playerType?: 'streamlink' | 'mpv' | 'both';
+  /** X position of the window */
+  windowX?: number;
+  /** Y position of the window */
+  windowY?: number;
+  /** Width of the window */
+  windowWidth?: number;
+  /** Height of the window */
+  windowHeight?: number;
+  /** Width of the screen */
+  width?: number;
+  /** Height of the screen */
+  height?: number;
+  /** X position of the screen */
+  x?: number;
+  /** Y position of the screen */
+  y?: number;
+  /** Whether this is the primary screen */
+  primary?: boolean;
+  /** Stream sources for this screen */
+  sources?: Array<{
+    /** Source type (holodex, twitch, youtube) */
+    type: string;
+    /** Source subtype (favorites, organization, etc.) */
+    subtype?: string;
+    /** Whether this source is enabled */
+    enabled: boolean;
+    /** Priority of this source (lower number = higher priority) */
+    priority?: number;
+    /** Maximum number of streams to fetch */
+    limit?: number;
+    /** Name of the organization (for holodex) */
+    name?: string;
+    /** Tags to filter by */
+    tags?: string[];
+  }>;
+  /** Sorting configuration */
+  sorting?: {
+    /** Field to sort by */
+    field: string;
+    /** Sort order */
+    order: 'asc' | 'desc';
+  };
+  /** Refresh interval in seconds */
+  refresh?: number;
+  /** Whether to auto-start streams on this screen */
+  autoStart?: boolean;
+  /** Additional screen-specific settings */
+  [key: string]: unknown;
 } 
\ No newline at end of file
