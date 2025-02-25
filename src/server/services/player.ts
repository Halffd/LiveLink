import { spawn, type SpawnOptions } from 'child_process';
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
  private manuallyClosedScreens: Set<number> = new Set();
  private isShuttingDown = false;
  private signalHandlersRegistered = false;

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

    // Register signal handlers only once
    if (!this.signalHandlersRegistered) {
      const signals = ['SIGINT', 'SIGTERM', 'SIGQUIT'];
      signals.forEach(signal => {
        process.once(signal, () => {
          if (!this.isShuttingDown) {
            logger.info(`Received ${signal} signal in PlayerService`, 'PlayerService');
            this.isShuttingDown = true;
            this.forceCleanup();
            process.exit(0);
          }
        });
      });
      this.signalHandlersRegistered = true;
    }

    // Don't forget to clear on cleanup
    this.events.once('cleanup', () => {
      clearInterval(logRotation);
      if (!this.isShuttingDown) {
        this.isShuttingDown = true;
        this.forceCleanup();
      }
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
    const args = [
        '--no-terminal',
        '--script=' + path.join(process.cwd(), 'scripts', 'livelink.lua'),
        '--script-opts=screen=' + options.screen,
        '--input-ipc-server=' + path.join('/tmp', `mpv-ipc-${options.screen}`),
        '--log-file=' + path.join(this.BASE_LOG_DIR, 'mpv', `mpv-screen${options.screen}-${new Date().toISOString()}.log`),
        '--force-window=yes',
        '--keep-open=yes',
        '--idle=yes'
    ];

    // Get screen config from player config
    const screenConfig = this.config.player.screens.find(s => s.id === options.screen);
    if (!screenConfig) {
      logger.error(`No screen config found for screen ${options.screen}`, 'PlayerService');
      throw new Error(`Invalid screen configuration for screen ${options.screen}`);
    }

    // Add geometry and window settings
    args.push(`--geometry=${screenConfig.width}x${screenConfig.height}+${screenConfig.x}+${screenConfig.y}`);
    if (screenConfig.windowMaximized) {
        args.push('--window-maximized=yes');
    }

    // Add all mpv.json config settings
    if (this.config.mpv) {
      Object.entries(this.config.mpv).forEach(([key, value]) => {
        // Skip null values and priority (handled by nice)
        if (value === null || key === 'priority') return;
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

  private getStreamlinkArgs(url: string, screen: number): string[] {
    // Start with base arguments
    const args: string[] = [
      url,          // URL must be first positional argument
      'best',       // Quality selection
      '--twitch-disable-hosting',  // Boolean flags without =true
      '--twitch-disable-ads',
      '--stream-segment-threads=4',
      '--ringbuffer-size=64M'
    ];

    // Add config settings from streamlink.json
    if (this.config.streamlink) {
      Object.entries(this.config.streamlink).forEach(([key, value]) => {
        // Skip null values, http_header (handled separately), and special cases
        if (value === null || 
            key === 'http_header' || 
            key === 'path' || 
            key === 'options') {
          return;
        }

        const paramKey = key.replace(/([A-Z])/g, '-$1').toLowerCase();

        // Handle arrays (like default_stream)
        if (Array.isArray(value)) {
          args.push(`--${paramKey}=${value.join(',')}`);
        }
        // Handle booleans - just add the flag without =true
        else if (typeof value === 'boolean') {
          if (value) args.push(`--${paramKey}`);
        }
        // Handle all other values
        else if (value !== undefined) {
          args.push(`--${paramKey}=${value}`);
        }
      });

      // Handle http headers separately
      if (this.config.streamlink.http_header) {
        Object.entries(this.config.streamlink.http_header).forEach(([header, value]) => {
          args.push(`--http-header`, `${header}=${value}`);  // Changed to use space instead of = for http-header
        });
      }
    }

    // Get screen config from player config
    const screenConfig = this.config.player.screens.find(s => s.id === screen);
    if (!screenConfig) {
      logger.error(`No screen config found for screen ${screen}`, 'PlayerService');
      throw new Error(`Invalid screen configuration for screen ${screen}`);
    }

    // Build MPV player args as a single quoted string
    const mpvArgs = [
      `--title=LiveLink-${screen}`,
      `--geometry=${screenConfig.width}x${screenConfig.height}+${screenConfig.x}+${screenConfig.y}`,
      `--volume=${screenConfig.volume}`,
      `--input-ipc-server=/tmp/mpv-ipc-${screen}`,
      `--log-file=${path.join(this.BASE_LOG_DIR, 'mpv', `mpv-screen${screen}-${Date.now()}.log`)}`,
      `--script=${path.join(process.cwd(), 'scripts', 'livelink.lua')}`,
      `--script-opts=screen=${screen}`,
      screenConfig.windowMaximized ? '--window-maximized=yes' : '--window-maximized=no'
    ].join(' ');

    // Add player and player args as a single quoted string
    args.push('--player', 'mpv');  // Changed to use space instead of =
    args.push('--player-args', `"${mpvArgs}"`);  // Changed to use space instead of =

    return args;
  }

  async startStream(options: StreamOptions & { screen: number }): Promise<StreamResponse> {
    // Don't start new streams during shutdown
    if (this.isShuttingDown) {
      logger.info('Ignoring stream start request during shutdown', 'PlayerService');
      return {
        screen: options.screen,
        message: 'Server is shutting down'
      };
    }

    try {
      // Clear the manually closed flag when starting a new stream
      this.manuallyClosedScreens.delete(options.screen);
      
      // Get screen config from player config
      const screenConfig = this.config.player.screens.find(s => s.id === options.screen);
      if (!screenConfig) {
        logger.error(`No screen config found for screen ${options.screen}`, 'PlayerService');
        throw new Error(`Invalid screen configuration for screen ${options.screen}`);
      }

      // Determine whether to use streamlink based on URL and stream type
      const isTwitchStream = options.url.includes('twitch.tv');
      const isYouTubeLive = options.url.includes('youtube.com') && 
        (options.url.includes('/live/') || options.url.includes('?v=') || options.url.includes('watch?v='));
      const useStreamlink = isTwitchStream || isYouTubeLive;
      
      // Check if there's already a player running for this screen
      const existingStream = this.streams.get(options.screen);
      if (existingStream?.process) {
        if (useStreamlink) {
          // For Streamlink streams, we need to restart the process with the new URL
          logger.info(`Restarting Streamlink for new URL on screen ${options.screen}`, 'PlayerService');
          await this.stopStream(options.screen);
        } else {
          // For direct MPV playback, we can just load the new URL
          logger.info(`Player already exists for screen ${options.screen}, loading new URL`, 'PlayerService');
          this.sendCommandToScreen(options.screen, `loadfile "${options.url}"`);
          return {
            screen: options.screen,
            message: `Stream loaded on existing player on screen ${options.screen}`
          };
        }
      }

      // Stop existing stream if any (in case stopStream wasn't called above)
      await this.stopStream(options.screen);

      // Create log paths
      const mpvLogPath = path.join(this.BASE_LOG_DIR, 'mpv', `mpv-screen${options.screen}-${Date.now()}.log`);

      let args: string[] = [];
      const command = useStreamlink ? 'streamlink' : '/usr/bin/mpv';

      if (useStreamlink) {
        // Get streamlink arguments including the URL
        args = this.getStreamlinkArgs(options.url, options.screen);
        logger.info(`Starting ${command} with streamlink for ${isTwitchStream ? 'Twitch' : 'YouTube Live'} stream`, 'PlayerService');
      } else {
        // Get all MPV arguments including screen config and window settings
        args = this.getMpvArgs(options);
        args.unshift(options.url);
        logger.info(`Starting ${command} directly for video playback`, 'PlayerService');
      }

      logger.info(`Logging MPV output to ${mpvLogPath}`, 'PlayerService');

      const spawnOptions: SpawnOptions & { nice?: number } = {
        nice: this.getProcessPriority(),
        env: {
          ...process.env,
          MPV_HOME: undefined,
          XDG_CONFIG_HOME: undefined,
          DISPLAY: process.env.DISPLAY || ':0'
        },
        shell: true
      };

      // Log the full command for debugging
      const fullCommand = [command, ...args].join(' ');
      logger.info(`Full command: ${fullCommand}`, 'PlayerService');

      const playerProcess = spawn(command, args, spawnOptions);

      // Handle process output
      if (playerProcess.stdout) {
        playerProcess.stdout.on('data', (data: Buffer) => {
          try {
            const output = data.toString('utf8').trim();
            // Only log if it contains printable characters
            if (output && /[\x20-\x7E]/.test(output)) {
              logger.debug(`[${command}-${options.screen}-stdout] ${output}`, 'PlayerService');
              this.outputCallback?.({
                screen: options.screen,
                data: output,
                type: 'stdout'
              });
            }
          } catch (error: unknown) {
            // Log error details for debugging
            logger.debug(
              `Received binary or invalid UTF-8 data on stdout for screen ${options.screen}: ${error instanceof Error ? error.message : String(error)}`,
              'PlayerService'
            );
          }
        });
      }

      if (playerProcess.stderr) {
        playerProcess.stderr.on('data', (data: Buffer) => {
          try {
            const output = data.toString('utf8').trim();
            // Only log if it contains printable characters
            if (output && /[\x20-\x7E]/.test(output)) {
              logger.debug(`[${command}-${options.screen}-stderr] ${output}`, 'PlayerService');
              this.errorCallback?.({
                screen: options.screen,
                error: output
              });
            }
          } catch (error: unknown) {
            // Log error details for debugging
            logger.debug(
              `Received binary or invalid UTF-8 data on stderr for screen ${options.screen}: ${error instanceof Error ? error.message : String(error)}`,
              'PlayerService'
            );
          }
        });
      }

      // Handle process exit
      playerProcess.on('exit', (code: number | null) => {
        logger.info(`Process for screen ${options.screen} exited with code ${code}`, 'PlayerService');
        
        // Only restart if:
        // 1. Process crashed (non-zero exit code)
        // 2. Not manually stopped
        // 3. Not at max retries
        if (code !== 0 && code !== null && !this.manuallyClosedScreens.has(options.screen)) {
          logger.error(`Stream process crashed with code ${code}, attempting recovery...`, 'PlayerService');
          const retryCount = this.streamRetries.get(options.screen) || 0;
          
          if (retryCount < this.MAX_RETRIES) {
            this.streamRetries.set(options.screen, retryCount + 1);
            setTimeout(() => {
              this.startStream(options).catch(error => {
                logger.error(
                  `Failed to restart stream on screen ${options.screen}`,
                  'PlayerService',
                  error instanceof Error ? error : new Error(String(error))
                );
              });
            }, this.RETRY_INTERVAL);
          } else {
            logger.error(`Max retries (${this.MAX_RETRIES}) reached for screen ${options.screen}`, 'PlayerService');
            this.streamRetries.delete(options.screen);
          }
        }
        
        // Clean up
        this.streams.delete(options.screen);
      });

      // Store stream information
      const instance: StreamInstance = {
        id: options.screen,
        screen: options.screen,
        process: playerProcess,
        url: options.url,
        quality: options.quality || 'best',
        platform: options.url.includes('youtube.com') ? 'youtube' : 'twitch',
        status: 'playing',
        volume: screenConfig.volume || this.config.player.defaultVolume
      };

      this.streams.set(options.screen, instance);

      // Set up stream refresh timer
      this.setupStreamRefresh(options.screen, options);

      // Set up inactive timer
      this.setupInactiveTimer(options.screen);

      // Store stream start time
      this.streamStartTimes.set(options.screen, Date.now());

      return {
        screen: options.screen,
        message: `Stream started on screen ${options.screen}`
      };
    } catch (error) {
      logger.error(
        `Failed to start stream on screen ${options.screen}`,
        'PlayerService',
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  async stopStream(screen: number, isManualStop: boolean = false): Promise<boolean> {
    try {
      const stream = this.streams.get(screen);
      if (!stream) return false;

      // If manual stop, mark the screen as manually closed
      if (isManualStop) {
        this.manuallyClosedScreens.add(screen);
        logger.info(`Screen ${screen} marked as manually closed`, 'PlayerService');
      }

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
      logger.info(`Stream stopped on screen ${screen}${isManualStop ? ' (manual stop)' : ''}`, 'PlayerService');
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
      platform: stream.platform,
      status: stream.status
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
    
    // Check if this was a manual close (e.g., user clicked X button)
    const wasManualClose = !this.streams.get(screen)?.process?.killed;
    if (wasManualClose) {
      this.manuallyClosedScreens.add(screen);
      logger.info(`Screen ${screen} was manually closed`, 'PlayerService');
    }
    
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
    if (this.isShuttingDown) {
      logger.debug('Cleanup already in progress, skipping', 'PlayerService');
      return;
    }

    this.isShuttingDown = true;
    this.forceCleanup();
  }

  private forceCleanup(): void {
    logger.info('Force cleaning up all player processes', 'PlayerService');
    
    // Kill only LiveLink MPV processes by checking window title
    try {
      exec('pgrep -f "LiveLink-[0-9]+" | xargs -r kill -9', (error) => {
        if (error && error.code !== 1) { // code 1 means no processes found
          logger.error('Error killing LiveLink MPV processes', 'PlayerService', error);
        }
      });
    } catch (error: unknown) {
      logger.error(
        'Failed to kill LiveLink MPV processes',
        'PlayerService',
        error instanceof Error ? error : new Error(String(error))
      );
    }

    // Kill only streamlink processes associated with LiveLink
    try {
      exec('pgrep -f "streamlink.*LiveLink-[0-9]+" | xargs -r kill -9', (error) => {
        if (error && error.code !== 1) { // code 1 means no processes found
          logger.error('Error killing LiveLink Streamlink processes', 'PlayerService', error);
        }
      });
    } catch (error: unknown) {
      logger.error(
        'Failed to kill LiveLink Streamlink processes',
        'PlayerService',
        error instanceof Error ? error : new Error(String(error))
      );
    }

    // Force kill all tracked processes
    this.streams.forEach((stream) => {
      const process = stream.process;
      if (process?.pid) {
        try {
          process.kill('SIGKILL');
        } catch {
          // Process might already be gone
        }
      }
    });

    // Clear all streams immediately
    this.streams.clear();

    // Clean up IPC and FIFO files
    for (const [screen, ipcPath] of this.ipcPaths) {
      try { 
        fs.unlinkSync(ipcPath);
      } catch {
        // Ignore errors during cleanup
      }
      this.ipcPaths.delete(screen);
    }
    
    for (const [screen, fifoPath] of this.fifoPaths) {
      try { 
        fs.unlinkSync(fifoPath);
      } catch {
        // Ignore errors during cleanup
      }
      this.fifoPaths.delete(screen);
    }
    
    // Clear all timers and state
    this.streamRefreshTimers.forEach(clearTimeout);
    this.streamRefreshTimers.clear();
    
    this.inactiveTimers.forEach(clearTimeout);
    this.inactiveTimers.clear();
    
    this.streamStartTimes.clear();
    this.lastStreamEndTime.clear();
    this.screenErrors.clear();
    this.disabledScreens.clear();
    this.manuallyClosedScreens.clear();

    logger.info('Cleanup complete', 'PlayerService');
  }
} 
