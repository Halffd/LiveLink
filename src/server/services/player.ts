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
import { execSync } from 'child_process';

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
      this.streams.forEach((_, screen) => {
        const process = this.streams.get(screen)?.process as unknown as ChildProcess;
        process?.kill('SIGKILL');
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

  private getMpvVideoArgs(): string[] {
    const mpvConfig = this.config.mpv || {};
    const args: string[] = [];

    // Video output configuration
    if (mpvConfig.vo) {
      args.push(`--vo=${mpvConfig.vo}`);
    }
    if (mpvConfig['gpu-api']) {
      args.push(`--gpu-api=${mpvConfig['gpu-api']}`);
    }
    if (mpvConfig['gpu-context']) {
      args.push(`--gpu-context=${mpvConfig['gpu-context']}`);
    }
    if (mpvConfig.hwdec) {
      args.push(`--hwdec=${mpvConfig.hwdec}`);
    }
    if (mpvConfig['gpu-hwdec-interop']) {
      args.push(`--gpu-hwdec-interop=${mpvConfig['gpu-hwdec-interop']}`);
    }

    // Add common video options with optimizations
    args.push(
      '--no-audio-display',           // Disable audio visualization
      '--force-window=immediate',     // Create window immediately
      '--no-terminal',               // No terminal output
      '--no-osc',                    // No on-screen controls
      '--no-osd-bar',                // No on-screen display bar
      '--osd-level=0',               // Disable on-screen display
      '--cursor-autohide=always',    // Always hide cursor
      '--no-border',                 // Borderless window
      '--no-keepaspect-window',      // Don't keep window aspect ratio
      '--gpu-dumb-mode=yes',         // Disable advanced GPU features
      '--opengl-swapinterval=0',     // Disable vsync
      '--opengl-early-flush=no',     // Reduce GPU-CPU synchronization
      '--vd-lavc-threads=4',         // Use 4 decoder threads
      '--hwdec-codecs=all',          // Enable hardware decoding for all codecs
      '--deband=no',                 // Disable debanding
      '--temporal-dither=no',        // Disable temporal dithering
      '--scale=bilinear',            // Use fast bilinear scaling
      '--cscale=bilinear',           // Use fast bilinear chroma scaling
      '--dscale=bilinear',           // Use fast bilinear downscaling
      '--scale-antiring=0',          // Disable scale ring filtering
      '--cscale-antiring=0',         // Disable chroma scale ring filtering
      '--correct-downscaling=no',    // Disable downscaling correction
      '--linear-downscaling=no',     // Disable linear downscaling
      '--sigmoid-upscaling=no',      // Disable sigmoid upscaling
      '--hdr-compute-peak=no'        // Disable HDR peak computation
    );

    return args;
  }

  async startStream(options: StreamOptions & { screen: number }): Promise<StreamResponse> {
    try {
      // Clear inactive timer when starting a stream
      this.clearInactiveTimer(options.screen);

      // If no URL is provided, get next unwatched stream from queue
      if (!options.url) {
        const nextStream = queueService.getNextStream(options.screen);
        if (!nextStream) {
          logger.info(`No unwatched streams left for screen ${options.screen}, will retry in 10s`, 'PlayerService');
          setTimeout(async () => {
            await this.handleEmptyQueue(options.screen);
          }, this.RETRY_INTERVAL);
          return {
            screen: options.screen,
            message: 'No unwatched streams available, will retry'
          };
        }
        options.url = nextStream.url;
      }

      // Mark stream as watched
      queueService.markStreamAsWatched(options.url);

      // Reset retry counter when starting a new stream intentionally
      if (!this.streamRetries.has(options.screen)) {
        this.streamRetries.set(options.screen, 0);
      }

      const screenConfig = this.config.player.screens.find(s => s.id === options.screen);
      if (!screenConfig) {
        logger.error(`No screen config found for screen ${options.screen}`, 'PlayerService');
        throw new Error(`Invalid screen configuration for screen ${options.screen}`);
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
        const mpvArgs = this.getMpvVideoArgs();
        // Streamlink base arguments
        args = [
          options.url,
          options.quality || this.config.player.defaultQuality,
          '--player', 'mpv',
          '--player-args',
          [
            `--volume=${this.config.player.defaultVolume}`,
            `--geometry=${screenConfig.width}x${screenConfig.height}+${screenConfig.x}+${screenConfig.y}`,
            '--keep-open=yes',
            '--no-terminal',
            '--hwdec=auto-safe',
            '--force-seekable=yes',
            '--keep-open-pause=yes',
            '--idle=yes',
            `--log-file=${mpvLogPath}`,
            ...mpvArgs,
            this.config.player.windowMaximized ? '--window-maximized=yes' : ''
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
        // Move the IPC path declarations before their usage
        const ipcPath = `/tmp/mpv-ipc-${options.screen}`;
        const inputFifoPath = `/tmp/mpv-input-${options.screen}`;
        this.ipcPaths.set(options.screen, ipcPath);
        this.fifoPaths.set(options.screen, inputFifoPath);

        // Then construct the args array using the now-defined ipcPath
        const mpvArgs = this.getMpvVideoArgs();
        args = [
          options.url,
          `--volume=${this.config.player.defaultVolume}`,
          `--geometry=${screenConfig.width}x${screenConfig.height}+${screenConfig.x}+${screenConfig.y}`,
          '--no-terminal',
          '--hwdec=auto-safe',
          '--force-seekable=yes',
          '--keep-open-pause=yes',
          '--idle=yes',
          '--cache=yes',
          '--demuxer-max-bytes=500M',
          '--cache-secs=30',
          '--network-timeout=30',
          `--input-ipc-server=${ipcPath}`,
          `--input-file=${inputFifoPath}`,
          '--vo=gpu',
          '--gpu-context=auto',
          '--no-border',
          this.config.player.windowMaximized ? '--window-maximized=yes' : '',
          '--sub-auto=all',
          ...mpvArgs
        ];

        // Add error recovery options
        args.push(
          '--script-opts=ytdl_hook-ytdl_path=yt-dlp',  // Use yt-dlp instead of youtube-dl
          '--ytdl-raw-options=ignore-errors=,quiet=,no-warnings=,retries=10'
        );

        // Create FIFO file if it doesn't exist
        try {
          if (!fs.existsSync(inputFifoPath)) {
            execSync(`mkfifo ${inputFifoPath}`);
          }
          
          // Set up FIFO listener
          const fifoStream = fs.createReadStream(inputFifoPath);
          fifoStream.on('data', (data) => {
            logger.debug(`MPV[${options.screen}] received command: ${data.toString()}`, 'PlayerService');
          });
        } catch (error) {
          logger.error(`Failed to create FIFO for screen ${options.screen}`, 'PlayerService', 
            error instanceof Error ? error : new Error(String(error)));
        }
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
      let hasReceivedOutput = false;

      // Handle process output
      if (process.stdout) {
        process.stdout.on('data', (data: Buffer) => {
          const output = data.toString().trim();
          if (output) {
            hasReceivedOutput = true;
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
            hasReceivedOutput = true;
            logger.debug(`[${command}-${options.screen}-stderr] ${output}`, 'PlayerService');
            
            // Check for specific error conditions
            if (output.includes('Failed to open') || 
                output.includes('Error when loading file') ||
                output.includes('Failed to get stream data')) {
              logger.warn(`Stream error detected for screen ${options.screen}: ${output}`, 'PlayerService');
              process.kill('SIGTERM');
            }
            
            this.errorCallback?.({
              screen: options.screen,
              error: output
            });
          }
        });
      }

      // Add initial startup timeout
      const startupTimeout = setTimeout(() => {
        if (!hasReceivedOutput) {
          logger.warn(`No output received from stream on screen ${options.screen} after 10s, killing process`, 'PlayerService');
          process.kill('SIGTERM');
        }
      }, 10000);

      process.on('error', (error: Error) => {
        clearTimeout(startupTimeout);
        logger.error(`[${command}-${options.screen}-error] ${error.message}`, 'PlayerService', error);
        this.clearStreamRefresh(options.screen);
        this.errorCallback?.({
          screen: options.screen,
          error: error.message
        });
      });

      // Handle process exit
      process.on('exit', (code: number | null) => {
        clearTimeout(startupTimeout);
        logger.info(`[${command}-${options.screen}-exit] Process exited with code ${code}`, 'PlayerService');
        this.clearStreamRefresh(options.screen);
        
        // Start inactive timer when stream ends
        this.setupInactiveTimer(options.screen);
        
        // Handle different exit codes
        if (code === 0 || code === null) {
          // Normal exit or killed - try to start next stream
          const nextStream = queueService.getNextStream(options.screen);
          if (nextStream) {
            logger.info(`Starting next stream on screen ${options.screen}: ${nextStream.url}`, 'PlayerService');
            setTimeout(() => {
              this.startStream({
                ...options,
                url: nextStream.url
              });
            }, 2000); // Increased delay between streams
          } else {
            logger.info(`No more unwatched streams for screen ${options.screen}`, 'PlayerService');
            if (this.errorCallback) {
              this.errorCallback({
                screen: options.screen,
                error: 'All streams watched',
                code: 0
              });
            }
          }
          this.streamRetries.delete(options.screen);
        } else {
          // Any error code - handle retries
          const retryCount = (this.streamRetries.get(options.screen) || 0) + 1;
          if (retryCount <= this.MAX_RETRIES) {
            logger.info(`Retrying stream on screen ${options.screen} (attempt ${retryCount})`, 'PlayerService');
            this.streamRetries.set(options.screen, retryCount);
            setTimeout(() => {
              this.startStream(options);
            }, 2000); // Increased delay between retries
          } else {
            logger.warn(`Max retries reached for screen ${options.screen}, trying next stream`, 'PlayerService');
            this.streamRetries.delete(options.screen);
            queueService.markStreamAsWatched(options.url);
            const nextStream = queueService.getNextStream(options.screen);
            if (nextStream) {
              setTimeout(() => {
                this.startStream({
                  ...options,
                  url: nextStream.url
                });
              }, 2000); // Increased delay before next stream
            } else {
              logger.info(`No more streams available for screen ${options.screen}, will retry in 10s`, 'PlayerService');
              setTimeout(() => {
                this.handleEmptyQueue(options.screen);
              }, this.RETRY_INTERVAL);
            }
          }
        }
        
        this.streams.delete(options.screen);
      });

      const instance: StreamInstance = {
        id: options.screen,
        screen: options.screen,
        url: options.url,
        quality: options.quality || 'best',
        process: process as unknown as NodeJS.Process,
        platform: options.url.includes('youtube.com') ? 'youtube' : 'twitch'
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
      // Start inactive timer on error
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
      const process = stream.process as unknown as ChildProcess;
      if (process.pid) {
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
          try { fs.unlinkSync(fifoPath); } catch {} // Suppress errors
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
} 