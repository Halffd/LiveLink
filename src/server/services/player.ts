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
      // Clear the manually closed flag when starting a new stream
      this.manuallyClosedScreens.delete(options.screen);
      
      // Get screen config from player config
      const screenConfig = this.config.player.screens.find(s => s.id === options.screen);
      if (!screenConfig) {
        logger.error(`No screen config found for screen ${options.screen}`, 'PlayerService');
        throw new Error(`Invalid screen configuration for screen ${options.screen}`);
      }

      // Stop existing stream if any
      await this.stopStream(options.screen);

      // Get unwatched URLs from the queue for this screen
      const queue = queueService.getQueue(options.screen);
      const unwatchedStreams = queue.filter(source => !queueService.isStreamWatched(source.url));
      
      // Normalize URLs (ensure proper URL format for each platform)
      const normalizedUrls = [options.url, ...unwatchedStreams.map(source => source.url)].map(url => {
        // Handle Twitch URLs
        if (url.includes('twitch.tv/') && !url.startsWith('https://')) {
          return `https://twitch.tv/${url.split('twitch.tv/')[1]}`;
        }
        // Handle YouTube URLs
        if (url.includes('youtube.com/') && !url.startsWith('https://')) {
          return `https://youtube.com/${url.split('youtube.com/')[1]}`;
        }
        return url;
      });

      // Create log paths
      const mpvLogPath = path.join(this.BASE_LOG_DIR, 'mpv', `mpv-screen${options.screen}-${Date.now()}.log`);
      const streamlinkLogPath = path.join(this.BASE_LOG_DIR, 'streamlink', `streamlink-screen${options.screen}-${Date.now()}.log`);

      // Determine whether to use streamlink
      const useStreamlink = this.config.player.preferStreamlink;
      const command = useStreamlink ? 'streamlink' : 'mpv';

      let args: string[] = [];
      const scriptsPath = path.join(process.cwd(), 'scripts', 'livelink.lua');

      if (useStreamlink) {
        // Streamlink configuration
        args = this.getStreamlinkArgs();
        args.push(
          '--player',
          'mpv',
          '--player-args',
          `--title=LiveLink-${options.screen} --geometry=${screenConfig.width}x${screenConfig.height}+${screenConfig.x}+${screenConfig.y} --volume=${screenConfig.volume} --input-ipc-server=/tmp/mpv-ipc-${options.screen} --log-file=${mpvLogPath} --script=${scriptsPath} --script-opts=screen=${options.screen} ${screenConfig.windowMaximized ? '--window-maximized=yes' : '--window-maximized=no'}`
        );
      } else {
        // Get all MPV arguments including screen config and window settings
        args = this.getMpvArgs(options);

        // Create a temporary m3u8 playlist file
        const playlistPath = path.join(this.BASE_LOG_DIR, 'playlists', `playlist-screen${options.screen}.m3u8`);
        await fs.promises.mkdir(path.dirname(playlistPath), { recursive: true });
        
        // Write m3u8 playlist file with proper format
        const m3u8Content = '#EXTM3U\n' + normalizedUrls.map(url => {
          return `#EXTINF:-1,${url}\n${url}`;
        }).join('\n');
        
        await fs.promises.writeFile(playlistPath, m3u8Content, 'utf8');

        // Add player options and playlist file as the first argument
        args.unshift(playlistPath);
        args.push(
          '--script-opts=ytdl_hook-ytdl_path=yt-dlp',
          '--keep-open=yes',
          '--force-window=yes',
          '--idle=yes',
          '--loop-playlist=no',
          '--playlist-start=0',
          '--no-resume-playback',
          '--no-save-position-on-quit',
          '--playlist-pos=0'  // Always start from the first item
        );

        // Clean up old playlist files except current one
        const playlistDir = path.join(this.BASE_LOG_DIR, 'playlists');
        fs.readdir(playlistDir, (err, files) => {
          if (err) return;
          files.forEach(file => {
            const filePath = path.join(playlistDir, file);
            if (filePath !== playlistPath && file.startsWith(`playlist-screen${options.screen}`)) {
              fs.unlink(filePath, () => {});
            }
          });
        });
      }

      logger.info(`Starting ${command} with playlist of ${normalizedUrls.length} streams`, 'PlayerService');
      logger.info(`Logging MPV output to ${mpvLogPath}`, 'PlayerService');
      if (useStreamlink) {
        logger.info(`Logging Streamlink output to ${streamlinkLogPath}`, 'PlayerService');
      }

      const spawnOptions: SpawnOptions & { nice?: number } = {
        nice: this.getProcessPriority(),
        env: {
          ...process.env,
          MPV_HOME: undefined,
          XDG_CONFIG_HOME: undefined
        }
      };

      const playerProcess = spawn(command, args, spawnOptions);

      // Handle process output
      if (playerProcess.stdout) {
        playerProcess.stdout.on('data', (data: Buffer) => {
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

      if (playerProcess.stderr) {
        playerProcess.stderr.on('data', (data: Buffer) => {
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
            // Try to get next stream from queue
            this.handleEmptyQueue(options.screen);
          }
        } else {
          // Clean exit or manual stop
          this.streams.delete(options.screen);
          if (code === 0) {
            // Normal exit, try next stream
            this.handleEmptyQueue(options.screen);
          }
        }
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