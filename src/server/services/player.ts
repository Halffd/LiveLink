import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { EventEmitter } from 'events';
import type { 
  StreamOptions
} from '../../types/stream.js';
import type { 
  StreamInstance, 
  StreamOutput, 
  StreamError,
  StreamResponse
} from '../../types/stream_instance.js';
import { logger } from './logger.js';
import { loadAllConfigs } from '../../config/loader.js';
import { exec } from 'child_process';
import { queueService } from './queue_service.js';
import path from 'path';
import fs from 'fs';

interface IpcMessage {
  type: string;
  screen?: number;
  data?: StreamInfo;
  error?: string;
  count?: number;
  reason?: string;
  url?: string;
  playlist?: StreamInstance[];
}

interface StreamInfo {
  path: string;
  title: string;
  duration: number;
  position: number;
  remaining: number;
  playlist_pos: number;
  playlist_count: number;
  error_count: number;
  last_error?: string;
}

export class PlayerService {
  private streams: Map<number, StreamInstance> = new Map();
  private events: EventEmitter;
  private outputCallback?: (data: StreamOutput) => void;
  private errorCallback?: (data: StreamError) => void;
  private config = loadAllConfigs();
  private streamRetries: Map<number, number> = new Map();
  private readonly MAX_RETRIES = 3;
  private RETRY_INTERVAL = 10000; // 10 seconds
  private readonly STREAM_REFRESH_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours in milliseconds
  private streamStartTimes: Map<number, number> = new Map();
  private streamRefreshTimers: Map<number, NodeJS.Timeout> = new Map();
  private readonly INACTIVE_RESET_TIMEOUT = 5 * 60 * 1000; // 5 minutes
  private inactiveTimers: Map<number, NodeJS.Timeout> = new Map();
  private lastStreamEndTime: Map<number, number> = new Map();
  private readonly BASE_LOG_DIR: string;
  private ipcPaths: Map<number, string> = new Map();
  private fifoPaths: Map<number, string> = new Map();
  private disabledScreens: Set<number> = new Set();
  private screenErrors: Map<number, { count: number; lastError: string }> = new Map();

  constructor() {
    this.events = new EventEmitter();
    
    // Set base log directory using absolute path
    this.BASE_LOG_DIR = path.resolve(process.cwd(), 'logs');
    
    // Create logs directory if it doesn't exist and clear old logs
    const logDirs = ['', 'mpv', 'streamlink'].map(dir => path.join(this.BASE_LOG_DIR, dir));
    logDirs.forEach(dir => {
      fs.mkdir(dir, { recursive: true }, (error) => {
        if (error) {
          logger.error(`Failed to create ${dir} directory`, 'PlayerService', error);
        } else {
          logger.debug(`Created/verified ${dir} directory exists`, 'PlayerService');
          // Clear old logs after ensuring directory exists
          this.clearOldLogs(dir);
        }
      });
    });
    
    // Check if mpv is installed
    exec('which mpv', (error, stdout) => {
      if (error) {
        logger.error('MPV is not installed or not in PATH', 'PlayerService', error);
        return;
      }
      logger.debug(`MPV found at: ${stdout.trim()}`, 'PlayerService');
    });

    // Add to PlayerService constructor
    const logRotation = setInterval(() => {
      this.streams.forEach((stream, screen) => {
        const logPath = path.join(this.BASE_LOG_DIR, 'mpv', `mpv-screen${screen}.log`);
        if (fs.existsSync(logPath)) {
          fs.renameSync(logPath, path.join(this.BASE_LOG_DIR, 'mpv', `mpv-screen${screen}-${Date.now()}.log`));
        }
      });
    }, 60 * 60 * 1000); // Rotate hourly

    // Don't forget to clear on cleanup
    this.events.on('cleanup', () => {
      clearInterval(logRotation);
      // Force kill all processes
      this.streams.forEach((stream) => {
        const process = stream.process;
        if (process && process.pid) {
          process.kill('SIGKILL');
        }
      });
      this.streams.clear();
    });
  }

  private clearOldLogs(directory: string) {
    // Validate that the directory is within our base logs directory
    const resolvedDir = path.resolve(directory);
    if (!resolvedDir.startsWith(this.BASE_LOG_DIR)) {
      logger.error(
        `Attempted to clear logs from unauthorized directory: ${directory}`, 
        'PlayerService'
      );
      return;
    }

    // Read directory contents
    fs.readdir(directory, { withFileTypes: true }, (err, files) => {
      if (err) {
        logger.error(`Failed to read directory ${directory}`, 'PlayerService', err);
        return;
      }

      // Process each file
      files.forEach(file => {
        if (file.isFile() && file.name.endsWith('.log')) {
          const filePath = path.join(directory, file.name);
          // Double check path is still within base directory
          const resolvedPath = path.resolve(filePath);
          if (resolvedPath.startsWith(this.BASE_LOG_DIR)) {
            fs.unlink(filePath, (unlinkErr) => {
              if (unlinkErr) {
                logger.error(`Failed to delete log file ${filePath}`, 'PlayerService', unlinkErr);
              } else {
                logger.debug(`Deleted log file ${filePath}`, 'PlayerService');
              }
            });
          } else {
            logger.error(
              `Attempted to delete file outside logs directory: ${filePath}`, 
              'PlayerService'
            );
          }
        }
      });
      
      logger.info(`Cleared old logs in ${directory}`, 'PlayerService');
    });
  }

  private setupStreamRefresh(screen: number, options: StreamOptions) {
    // Clear any existing refresh timer
    this.clearStreamRefresh(screen);
    
    // Record stream start time
    this.streamStartTimes.set(screen, Date.now());
    
    // Set up periodic refresh
    const timer = setTimeout(() => {
      logger.info(`Refreshing stream on screen ${screen} after ${this.STREAM_REFRESH_INTERVAL/1000/60/60} hours`, 'PlayerService');
      this.restartStream(screen, options).catch(error => {
        logger.error(
          `Failed to refresh stream on screen ${screen}`,
          'PlayerService',
          error instanceof Error ? error : new Error(String(error))
        );
      });
    }, this.STREAM_REFRESH_INTERVAL);

    this.streamRefreshTimers.set(screen, timer);
  }

  private clearStreamRefresh(screen: number) {
    const timer = this.streamRefreshTimers.get(screen);
    if (timer) {
      clearTimeout(timer);
      this.streamRefreshTimers.delete(screen);
    }
    this.streamStartTimes.delete(screen);
  }

  private async restartStream(screen: number, options: StreamOptions) {
    logger.info(`Restarting stream on screen ${screen}`, 'PlayerService');
    await this.stopStream(screen);
    
    // Small delay to ensure cleanup
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    return this.startStream({
      ...options,
      screen
    });
  }

  private setupInactiveTimer(screen: number) {
    // Clear any existing timer
    this.clearInactiveTimer(screen);
    
    // Record when the stream ended
    this.lastStreamEndTime.set(screen, Date.now());
    
    // Set up timer to reset watched streams after inactivity
    const timer = setTimeout(async () => {
      // Only reset if the screen is still inactive
      if (!this.streams.has(screen)) {
        logger.info(`Screen ${screen} has been inactive for ${this.INACTIVE_RESET_TIMEOUT/1000/60} minutes, resetting watched streams`, 'PlayerService');
        queueService.clearWatchedStreams();
        // Try to get new streams
        await this.handleEmptyQueue(screen);
      }
    }, this.INACTIVE_RESET_TIMEOUT);

    this.inactiveTimers.set(screen, timer);
  }

  private clearInactiveTimer(screen: number) {
    const timer = this.inactiveTimers.get(screen);
    if (timer) {
      clearTimeout(timer);
      this.inactiveTimers.delete(screen);
    }
    this.lastStreamEndTime.delete(screen);
  }

  private getProcessPriority(): number {
    const mpvConfig = this.config.mpv || {};
    const priority = mpvConfig.priority?.toLowerCase() || 'normal';
    const isX11Context = mpvConfig['gpu-context'] === 'x11';

    // If using x11 context, use ultra low priority to reduce CPU impact
    if (isX11Context) {
      return 19; // Lowest possible nice value
    }

    // Otherwise use configured priority
    switch (priority) {
      case 'realtime':
        return -20; // Highest priority (requires root)
      case 'high':
        return -10; // Higher priority
      case 'above_normal':
        return -5;  // Slightly above normal
      case 'below_normal':
        return 5;   // Slightly below normal
      case 'low':
        return 10;  // Lower priority
      case 'idle':
        return 19;  // Lowest priority
      default:
        return 0;   // Normal priority
    }
  }

  private getMpvArgs(options: StreamOptions & { screen: number }): string[] {
    // Get screen config from player config
    const screenConfig = this.config.player.screens.find(s => s.id === options.screen);
    if (!screenConfig) {
      logger.error(`No screen config found for screen ${options.screen}`, 'PlayerService');
      throw new Error(`Invalid screen configuration for screen ${options.screen}`);
    }

    const ipcPath = `/tmp/mpv-ipc-${options.screen}`;
    const inputFifoPath = `/tmp/mpv-input-${options.screen}`;
    this.ipcPaths.set(options.screen, ipcPath);
    this.fifoPaths.set(options.screen, inputFifoPath);

    const mpvLogPath = path.join(this.BASE_LOG_DIR, 'mpv', `mpv-screen${options.screen}-${Date.now()}.log`);

    // Base arguments that override mpv.json settings
    const args = [
      `--title=LiveLink-${options.screen}`,
      `--geometry=${screenConfig.width}x${screenConfig.height}+${screenConfig.x}+${screenConfig.y}`,
      `--volume=${this.config.player.defaultVolume}`,
      `--input-ipc-server=${ipcPath}`,
      `--log-file=${mpvLogPath}`,
      `--screen=${options.screen}`, // Add screen ID for the Lua script
      `--scripts=${path.join(process.cwd(), 'scripts', 'livelink.lua')}`, // Add Lua script
      this.config.player.windowMaximized ? '--window-maximized=yes' : '--window-maximized=no'
    ];

    // Add all mpv.json config settings
    if (this.config.mpv) {
      Object.entries(this.config.mpv).forEach(([key, value]) => {
        // Skip null values
        if (value === null) return;
        // Handle boolean values
        if (typeof value === 'boolean') {
          args.push(value ? `--${key}` : `--no-${key}`);
        }
        // Handle all other values
        else if (value !== undefined) {
          args.push(`--${key}=${value}`);
        }
      });
    }

    return args;
  }

  private getStreamlinkArgs(): string[] {
    const args: string[] = ['--stdout'];

    // Add all streamlink.json config settings
    if (this.config.streamlink) {
      Object.entries(this.config.streamlink).forEach(([key, value]) => {
        // Skip null values and http_header (handled separately)
        if (value === null || key === 'http_header') return;

        // Handle arrays (like default_stream)
        if (Array.isArray(value)) {
          args.push(`--${key}`, value.join(','));
        }
        // Handle booleans
        else if (typeof value === 'boolean') {
          if (value) args.push(`--${key}`);
        }
        // Handle all other values
        else if (value !== undefined) {
          args.push(`--${key}`, value.toString());
        }
      });

      // Handle http headers separately
      if (this.config.streamlink.http_header) {
        Object.entries(this.config.streamlink.http_header).forEach(([header, value]) => {
          args.push('--http-header', `${header}=${value}`);
        });
      }
    }

    return args;
  }

  async startStream(options: StreamOptions & { screen: number }): Promise<StreamResponse> {
    try {
      // Clear inactive timer when starting a stream
      this.clearInactiveTimer(options.screen);

      // Validate screen configuration
      const screenConfig = this.config.player.screens.find(s => s.id === options.screen);
      if (!screenConfig) {
        logger.error(`No screen config found for screen ${options.screen}`, 'PlayerService');
        return {
          screen: options.screen,
          error: `Invalid screen configuration for screen ${options.screen}`
        };
      }

      // Get queue for this screen
      const queue = queueService.getQueue(options.screen);
      const urls = [options.url, ...queue.map(s => s.url)];

      // If no URLs are provided, get next unwatched stream from queue
      if (urls.length === 0) {
        logger.info(`No unwatched streams left for screen ${options.screen}, will retry in 10s`, 'PlayerService');
        setTimeout(async () => {
          await this.handleEmptyQueue(options.screen);
        }, this.RETRY_INTERVAL);
        return {
          screen: options.screen,
          message: 'No unwatched streams available, will retry'
        };
      }

      // Stop any existing stream on this screen
      await this.stopStream(options.screen);

      logger.debug(`Screen config: ${JSON.stringify(screenConfig)}`, 'PlayerService');

      // Determine if we should use streamlink (only for Twitch now)
      const isTwitchStream = options.url.includes('twitch.tv');
      const useStreamlink = isTwitchStream && this.config.player.preferStreamlink;

      let command = 'mpv';
      let args: string[] = [];

      // Setup log file paths with absolute paths
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const mpvLogPath = path.join(this.BASE_LOG_DIR, 'mpv', `mpv-screen${options.screen}-${timestamp}.log`);
      const streamlinkLogPath = path.join(this.BASE_LOG_DIR, 'streamlink', `streamlink-screen${options.screen}-${timestamp}.log`);

      if (useStreamlink) {
        command = 'streamlink';
        const mpvArgs = this.getMpvArgs(options);
        // Streamlink base arguments
        args = [
          urls[0], // Only first URL for streamlink
          options.quality || this.config.player.defaultQuality,
          '--player', 'mpv',
          '--player-args',
          [
            ...mpvArgs,
            ...this.getStreamlinkArgs()
          ].join(' ')
        ];

        // Streamlink-specific options for Twitch
        args.push(
          '--stream-sorting-excludes', '>1080p,<480p',
          '--twitch-disable-hosting',
          '--twitch-disable-ads',
          '--retry-open', '3',
          '--retry-streams', '5',
          '--stream-timeout', '120',
          '--player-no-close',
          '--player-continuous-http',
          '--stream-segment-threads', '2',
          '--hls-playlist-reload-time', '1',
          '--hls-live-edge', '3',
          '--ringbuffer-size', '32M',
          '--loglevel', 'debug',
          '--logfile', streamlinkLogPath,
          '--stream-segment-attempts', '5',
          '--stream-segment-timeout', '10',
          '--retry-max', '5',
          '--http-header', 
          'User-Agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          '--http-header',
          'Accept-Language=en-US,en;q=0.9'
        );
      } else {
        // Get all MPV arguments including screen config and window settings
        args = this.getMpvArgs(options);

        // Add all URLs to playlist
        args.push(...urls);

        // Add additional MPV-specific arguments
        args.push(
          '--script-opts=ytdl_hook-ytdl_path=yt-dlp',
          '--keep-open=yes',
          '--force-window=yes'
        );
      }

      logger.debug(`Starting ${command} with args: ${args.join(' ')}`, 'PlayerService');
      logger.info(`Logging MPV output to ${mpvLogPath}`, 'PlayerService');
      if (useStreamlink) {
        logger.info(`Logging Streamlink output to ${streamlinkLogPath}`, 'PlayerService');
      }

      const spawnOptions: SpawnOptions & { nice?: number } = {
        nice: this.getProcessPriority()
      };

      logger.info(`Starting ${command} ${args.join(' ')}`, 'PlayerService');
      const process = spawn(command, args, spawnOptions) as unknown as ChildProcess;

      // Handle process output
      if (process.stdout) {
        process.stdout.on('data', (data: Buffer) => {
          const output = data.toString().trim();
          if (output) {
            logger.debug(`[${command}-${options.screen}-stdout] ${output}`, 'PlayerService');
            this.outputCallback?.({
              screen: options.screen,
              data: output,
              type: 'stdout'
            });
          }
        });
      }

      if (process.stderr) {
        process.stderr.on('data', (data: Buffer) => {
          const output = data.toString().trim();
          if (output) {
            logger.debug(`[${command}-${options.screen}-stderr] ${output}`, 'PlayerService');
            this.errorCallback?.({
              screen: options.screen,
              error: output
            });
          }
        });
      }

      process.on('error', (error: Error) => {
        logger.error(`[${command}-${options.screen}-error] ${error.message}`, 'PlayerService', error);
        this.clearStreamRefresh(options.screen);
        this.errorCallback?.({
          screen: options.screen,
          error: error.message
        });
      });

      // Handle process exit
      process.on('exit', (code: number | null) => {
        logger.info(`[${command}-${options.screen}-exit] Process exited with code ${code}`, 'PlayerService');
        this.clearStreamRefresh(options.screen);
        this.setupInactiveTimer(options.screen);
        this.streams.delete(options.screen);
      });

      const instance: StreamInstance = {
        id: options.screen,
        screen: options.screen,
        url: options.url,
        quality: options.quality || 'best',
        process: process,
        platform: options.url.includes('youtube.com') ? 'youtube' : 'twitch',
        status: 'playing',
        volume: this.config.player.defaultVolume,
        startTime: Date.now(),
        error: undefined
      };

      this.streams.set(options.screen, instance);
      
      // Set up stream refresh timer
      this.setupStreamRefresh(options.screen, options);
      
      logger.info(`Stream started on screen ${options.screen}`, 'PlayerService');
      
      return {
        screen: options.screen,
        message: `Stream started on screen ${options.screen}`
      };

    } catch (error) {
      this.clearStreamRefresh(options.screen);
      this.setupInactiveTimer(options.screen);
      logger.error(
        'Failed to start stream',
        'PlayerService',
        error instanceof Error ? error : new Error(String(error))
      );
      return {
        screen: options.screen,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async stopStream(screen: number): Promise<boolean> {
    try {
      const stream = this.streams.get(screen);
      if (!stream) return false;

      // Clear any pending retries
      this.streamRetries.delete(screen);
      this.clearInactiveTimer(screen);
      this.clearStreamRefresh(screen);

      // Cleanup process
      const process = stream.process;
      if (process && process.pid) {
        // Double termination pattern
        process.kill('SIGINT');
        setTimeout(() => {
          if (!process.killed) {
            process.kill('SIGKILL');
          }
        }, 1000);
      }

      // Cleanup IPC/FIFO after process death
      setTimeout(() => {
        const fifoPath = this.fifoPaths.get(screen);
        if (fifoPath) {
          try { 
            fs.unlinkSync(fifoPath); 
          } catch {
            // Ignore error, file may not exist
            logger.debug(`Failed to remove FIFO file ${fifoPath}`, 'PlayerService');
          }
          this.fifoPaths.delete(screen);
        }
        this.ipcPaths.delete(screen);
      }, 2000);

      this.streams.delete(screen);
      logger.info(`Stream stopped on screen ${screen}`, 'PlayerService');
      return true;
    } catch (error) {
      logger.error(
        'Failed to stop stream', 
        'PlayerService', 
        error instanceof Error ? error : new Error(String(error))
      );
      return false;
    }
  }

  getActiveStreams() {
    return Array.from(this.streams.entries()).map(([screen, stream]) => ({
      screen,
      url: stream.url,
      quality: stream.quality,
      platform: stream.platform
    }));
  }

  onStreamOutput(callback: (data: StreamOutput) => void) {
    this.outputCallback = callback;
  }

  onStreamError(callback: (data: StreamError) => void) {
    this.errorCallback = callback;
  }

  isRetrying(screen: number): boolean {
    return this.streamRetries.has(screen);
  }

  resetRetries(screen: number): void {
    this.streamRetries.delete(screen);
  }

  clearWatchedStreams() {
    queueService.clearWatchedStreams();
    logger.info('Cleared watched streams history', 'PlayerService');
  }

  isStreamWatched(url: string): boolean {
    return queueService.isStreamWatched(url);
  }

  getWatchedStreams(): string[] {
    return queueService.getWatchedStreams();
  }

  // Get the current queue for a screen
  getStreamQueue(screen: number): string[] {
    return queueService.getQueue(screen).map(s => s.url);
  }

  // Clear the queue for a screen
  clearStreamQueue(screen: number) {
    queueService.clearQueue(screen);
    logger.info(`Cleared stream queue for screen ${screen}`, 'PlayerService');
  }

  // Clear all queues
  clearAllQueues() {
    queueService.clearAllQueues();
    // Clear all inactive timers
    for (const screen of this.inactiveTimers.keys()) {
      this.clearInactiveTimer(screen);
    }
    logger.info('Cleared all stream queues', 'PlayerService');
  }

  private async handleEmptyQueue(screen: number) {
    try {
      logger.info(`Attempting to fetch new streams for screen ${screen}`, 'PlayerService');
      // Emit event to trigger stream manager to fetch new streams
      this.errorCallback?.({
        screen,
        error: 'Fetching new streams',
        code: -1
      });
    } catch (error) {
      logger.error(
        'Failed to handle empty queue', 
        'PlayerService',
        error instanceof Error ? error : new Error(String(error))
      );
      // Retry after interval
      setTimeout(() => {
        this.handleEmptyQueue(screen);
      }, this.RETRY_INTERVAL);
    }
  }

  public sendCommandToScreen(screen: number, command: string): void {
    const ipcPath = this.ipcPaths.get(screen);
    if (!ipcPath) {
      logger.warn(`No IPC path found for screen ${screen}`, 'PlayerService');
      return;
    }

    try {
      const cmd = `echo "${command}" | socat - ${ipcPath}`;
      exec(cmd, (error) => {
        if (error) {
          logger.error(`Failed to send command to screen ${screen}`, 'PlayerService', error);
        }
      });
    } catch (error) {
      logger.error(`Command send error for screen ${screen}`, 'PlayerService', 
        error instanceof Error ? error : new Error(String(error)));
    }
  }

  public sendCommandToAll(command: string): void {
    this.ipcPaths.forEach((_, screen) => {
      this.sendCommandToScreen(screen, command);
    });
  }

  private handleStreamInfo(screen: number, data: StreamInfo): void {
    logger.debug(`Stream info update for screen ${screen}: ${JSON.stringify(data)}`, 'PlayerService');
    const stream = this.streams.get(screen);
    if (stream) {
      stream.title = data.title;
      stream.progress = Math.floor((data.position / data.duration) * 100);
    }
  }

  private handleWatchedStream(screen: number, url: string): void {
    logger.debug(`Stream marked as watched on screen ${screen}: ${url}`, 'PlayerService');
    const stream = this.streams.get(screen);
    if (stream) {
      stream.watched = true;
    }
  }

  private handlePlaylistUpdate(screen: number, playlist: StreamInstance[]): void {
    logger.debug(`Playlist update for screen ${screen}: ${JSON.stringify(playlist)}`, 'PlayerService');
    const stream = this.streams.get(screen);
    if (stream) {
      stream.playlist = playlist;
    }
  }

  private handleIpcMessage(screen: number, message: IpcMessage): void {
    try {
      switch (message.type) {
        case 'stream_info':
          if (message.data) this.handleStreamInfo(screen, message.data);
          break;
        case 'watched':
          if (message.url) this.handleWatchedStream(screen, message.url);
          break;
        case 'playlist_update':
          if (message.playlist) this.handlePlaylistUpdate(screen, message.playlist);
          break;
        case 'error':
          if (message.error) this.handleStreamError(screen, message.error, message.count || 1);
          break;
        case 'disable_screen':
          if (message.reason) this.handleDisableScreen(screen, message.reason);
          break;
        case 'player_shutdown':
          void this.handlePlayerShutdown(screen);
          break;
        case 'toggle_screen':
          if (message.screen !== undefined) void this.handleToggleScreen(message.screen);
          break;
        case 'request_update':
          void this.handleRequestUpdate(screen);
          break;
        default:
          logger.warn(`Unknown IPC message type: ${message.type}`, 'PlayerService');
      }
    } catch (error) {
      logger.error(
        `Error handling IPC message: ${error instanceof Error ? error.message : String(error)}`,
        'PlayerService',
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  private handleStreamError(screen: number, error: string, count: number): void {
    logger.error(`Stream error on screen ${screen}: ${error}`, 'PlayerService');
    
    const errorInfo = this.screenErrors.get(screen) || { count: 0, lastError: '' };
    errorInfo.count = count;
    errorInfo.lastError = error;
    this.screenErrors.set(screen, errorInfo);

    if (count >= this.MAX_RETRIES) {
      this.handleDisableScreen(screen, `Too many errors: ${error}`);
    } else {
      // Attempt to restart the stream
      const stream = this.streams.get(screen);
      if (stream) {
        void this.restartStream(screen, stream);
      }
    }
  }

  private handleDisableScreen(screen: number, reason: string): void {
    logger.warn(`Disabling screen ${screen}: ${reason}`, 'PlayerService');
    this.disabledScreens.add(screen);
    void this.stopStream(screen);
  }

  private async handlePlayerShutdown(screen: number): Promise<void> {
    logger.info(`Player shutdown on screen ${screen}`, 'PlayerService');
    this.streams.delete(screen);
    
    // Check if all screens are closed
    if (this.streams.size === 0) {
      logger.info('All players closed, performing cleanup', 'PlayerService');
      this.cleanup();
    }
  }

  private async handleToggleScreen(screen: number): Promise<void> {
    const stream = this.streams.get(screen);
    
    if (stream) {
      // Screen is active, stop it
      await this.stopStream(screen);
    } else if (!this.disabledScreens.has(screen)) {
      // Screen is inactive and not disabled, start it
      const queue = queueService.getQueue(screen);
      if (queue.length > 0) {
        await this.startStream({ screen, url: queue[0].url });
      } else {
        logger.info(`No streams in queue for screen ${screen}`, 'PlayerService');
      }
    } else {
      logger.warn(`Cannot toggle disabled screen ${screen}`, 'PlayerService');
    }
  }

  private async handleRequestUpdate(screen: number): Promise<void> {
    try {
      const queue = queueService.getQueue(screen);
      if (queue.length > 0) {
        await this.startStream({ screen, url: queue[0].url });
      }
    } catch (error) {
      logger.error(
        `Failed to handle update request for screen ${screen}: ${error instanceof Error ? error.message : String(error)}`,
        'PlayerService',
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  private cleanup(): void {
    // Clean up IPC and FIFO files
    for (const [screen, ipcPath] of this.ipcPaths) {
      try { 
        fs.unlinkSync(ipcPath);
        logger.debug(`Removed IPC file: ${ipcPath}`, 'PlayerService');
      } catch {
        logger.debug(`Failed to remove IPC file: ${ipcPath}`, 'PlayerService');
      }
      this.ipcPaths.delete(screen);
    }
    
    for (const [screen, fifoPath] of this.fifoPaths) {
      try { 
        fs.unlinkSync(fifoPath);
        logger.debug(`Removed FIFO file: ${fifoPath}`, 'PlayerService');
      } catch {
        logger.debug(`Failed to remove FIFO file: ${fifoPath}`, 'PlayerService');
      }
      this.fifoPaths.delete(screen);
    }
    
    // Clear all timers and state
    this.streamRefreshTimers.forEach((timer: NodeJS.Timeout) => clearTimeout(timer));
    this.streamRefreshTimers.clear();
    
    this.inactiveTimers.forEach((timer: NodeJS.Timeout) => clearTimeout(timer));
    this.inactiveTimers.clear();
    
    this.streamStartTimes.clear();
    this.lastStreamEndTime.clear();
    this.screenErrors.clear();
    this.disabledScreens.clear();
  }
} 