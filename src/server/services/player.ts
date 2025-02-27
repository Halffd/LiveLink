import { spawn, type SpawnOptions, type ChildProcess } from 'child_process';
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
  private readonly MAX_RETRIES = 5;
  private RETRY_INTERVAL = 30000;
  private readonly STREAM_REFRESH_INTERVAL = 4 * 60 * 60 * 1000;
  private streamStartTimes: Map<number, number> = new Map();
  private streamRefreshTimers: Map<number, NodeJS.Timeout> = new Map();
  private readonly INACTIVE_RESET_TIMEOUT = 5 * 60 * 1000;
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
  private healthCheckIntervals: Map<number, NodeJS.Timeout> = new Map();
  private mpvPath = '';
  private startupLocks: Map<number, boolean> = new Map();

  constructor() {
    this.events = new EventEmitter();
    this.BASE_LOG_DIR = path.join(process.cwd(), 'logs');
    this.clearOldLogs(this.BASE_LOG_DIR);
    this.clearOldLogs(path.join(this.BASE_LOG_DIR, 'mpv'));
    this.clearOldLogs(path.join(this.BASE_LOG_DIR, 'streamlink'));

    // Find MPV path
    exec('which mpv', (error, stdout) => {
      if (error) {
        logger.error('Failed to find MPV', 'PlayerService', error);
        return;
      }
      logger.debug(`MPV found at: ${stdout.trim()}`, 'PlayerService');
      this.mpvPath = stdout.trim();
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
    try {
      fs.mkdirSync(directory, { recursive: true });
      logger.debug(`Created/verified ${directory} directory exists`, 'PlayerService');
      
      const files = fs.readdirSync(directory);
      const now = Date.now();
      const maxAge = 24 * 60 * 60 * 1000; // 24 hours
      
      for (const file of files) {
        const filePath = path.join(directory, file);
        try {
          const stats = fs.statSync(filePath);
          if (now - stats.mtimeMs > maxAge) {
            fs.unlinkSync(filePath);
            logger.debug(`Deleted old log file: ${filePath}`, 'PlayerService');
          }
        } catch {
          logger.warn(`Failed to clean up log file at ${filePath}`, 'PlayerService');
        }
      }
    } catch {
      logger.error(`Failed to clean up logs in ${directory}`, 'PlayerService');
    }
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
    const screenConfig = this.config.player.screens.find(s => s.screen === options.screen);
    if (!screenConfig) {
      throw new Error(`Invalid screen number: ${options.screen}`);
    }

    const args = [
      options.url,
      '--no-terminal',
      `--script=${path.join(process.cwd(), 'scripts', 'livelink.lua')}`,
      `--script-opts=screen=${options.screen}`,
      `--input-ipc-server=${this.ipcPaths.get(options.screen)}`,
      `--log-file=${path.join(this.BASE_LOG_DIR, `mpv-screen${options.screen}-${new Date().toISOString()}.log`)}`,
      '--force-window=yes',
      '--keep-open=yes',
      '--idle=yes',
      `--volume=${options.volume !== undefined ? options.volume : (screenConfig.volume !== undefined ? screenConfig.volume : this.config.player.defaultVolume)}`
    ];

    // Add geometry settings
    args.push(`--geometry=${screenConfig.width}x${screenConfig.height}+${screenConfig.x}+${screenConfig.y}`);

    // Add window maximized setting if specified
    if (options.windowMaximized || screenConfig.windowMaximized) {
      args.push('--window-maximized=yes');
    }

    return args;
  }

  private getStreamlinkArgs(url: string, screen: number): string[] {
    // Get screen config
    const screenConfig = this.config.player.screens.find(s => s.screen === screen);
    if (!screenConfig) {
      throw new Error(`Invalid screen number: ${screen}`);
    }

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
          args.push(`--http-header`, `${header}=${value}`);
        });
      }
    }

    // Build MPV player args
    const mpvArgs = [
      `--title=LiveLink-${screen}`,
      `--geometry=${screenConfig.width}x${screenConfig.height}+${screenConfig.x}+${screenConfig.y}`,
      `--volume=${screenConfig.volume !== undefined ? screenConfig.volume : this.config.player.defaultVolume}`,
      `--input-ipc-server=/tmp/mpv-ipc-${screen}`,
      `--log-file=${path.join(this.BASE_LOG_DIR, 'mpv', `mpv-screen${screen}-${Date.now()}.log`)}`,
      `--script=${path.join(process.cwd(), 'scripts', 'livelink.lua')}`,
      `--script-opts=screen=${screen}`,
      `--force-window=yes`,
      `--keep-open=yes`,
      `--no-terminal`,
      screenConfig.windowMaximized ? '--window-maximized=yes' : '--window-maximized=no'
    ];

    // Add MPV config settings
    if (this.config.mpv) {
      Object.entries(this.config.mpv).forEach(([key, value]) => {
        if (value !== null && value !== undefined && key !== 'priority') {
          mpvArgs.push(`--${key}=${value}`);
        }
      });
    }

    // Add player and player args
    args.push('--player', 'mpv');
    args.push('--player-args', mpvArgs.join(' '));

    return args;
  }

  async startStream(options: StreamOptions & { screen: number }): Promise<StreamResponse> {
    const { screen } = options;
    
    // Check if we're already at the maximum number of streams
    const activeStreams = Array.from(this.streams.values()).filter(s => s.process !== null);
    if (activeStreams.length >= this.config.player.maxStreams) {
        logger.warn(`Maximum number of streams (${this.config.player.maxStreams}) reached`, 'PlayerService');
        return {
            screen,
            message: `Maximum number of streams (${this.config.player.maxStreams}) reached`,
            error: `Maximum number of streams (${this.config.player.maxStreams}) reached`,
            success: false
        };
    }

    // Check if there's a startup in progress
    if (this.startupLocks.get(screen)) {
      logger.info(`Stream startup already in progress for screen ${screen}, waiting...`, 'PlayerService');
      // Wait for a bit to allow the startup to complete
      await new Promise(resolve => setTimeout(resolve, 2000));
      return {
        screen,
        message: `Stream startup in progress for screen ${screen}`,
        success: false
      };
    }

    // Set startup lock
    this.startupLocks.set(screen, true);

    try {
      // Kill any existing processes for this screen
      await this.killExistingProcesses(screen);

      // Clear any existing stream data for this screen
      this.streams.delete(screen);
      this.streamRetries.delete(screen);
      this.clearStreamRefresh(screen);
      this.clearInactiveTimer(screen);

      // Check if screen is disabled
      if (this.disabledScreens.has(screen)) {
        return {
          screen,
          message: `Screen ${screen} is disabled`,
          error: `Screen ${screen} is disabled`,
          success: false
        };
      }
      
      // Get screen configuration
      const screenConfig = this.config.player.screens.find(s => s.screen === screen);
      if (!screenConfig) {
        return {
          screen,
          message: `Screen ${screen} configuration not found`,
          error: `Screen ${screen} configuration not found`,
          success: false
        };
      }
      
      // Determine which player to use based on screen configuration
      // If screen has a specific playerType, use that, otherwise use global preferStreamlink setting
      const useStreamlink = screenConfig.playerType 
        ? screenConfig.playerType === 'streamlink'
        : this.config.player.preferStreamlink;
      
      // Don't start new streams during shutdown
      if (this.isShuttingDown) {
        logger.info('Ignoring stream start request during shutdown', 'PlayerService');
        return {
          screen,
          message: 'Server is shutting down',
          success: false
        };
      }

      try {
        // Clear the manually closed flag when starting a new stream
        this.manuallyClosedScreens.delete(screen);
        
        // Check if there's already a player running for this screen
        const existingStream = this.streams.get(screen);
        if (existingStream?.process) {
          if (useStreamlink) {
            // For Streamlink streams, we need to restart the process with the new URL
            logger.info(`Restarting Streamlink for new URL on screen ${screen}`, 'PlayerService');
            await this.stopStream(screen);
          } else {
            // For direct MPV playback, we can just load the new URL
            logger.info(`Player already exists for screen ${screen}, loading new URL`, 'PlayerService');
            this.sendCommandToScreen(screen, `loadfile "${options.url}"`);
            return {
              screen: screen,
              message: `Stream loaded on existing player on screen ${screen}`,
              success: true
            };
          }
        }

        // Stop existing stream if any (in case stopStream wasn't called above)
        await this.stopStream(screen);

        // Create log paths
        const mpvLogPath = path.join(this.BASE_LOG_DIR, 'mpv', `mpv-screen${screen}-${Date.now()}.log`);

        const command = useStreamlink ? 'streamlink' : this.mpvPath;
        let args: string[] = [];

        if (useStreamlink) {
          // Normal streamlink operation for URLs
          args = this.getStreamlinkArgs(options.url, screen);
          logger.info(`Starting ${command} with streamlink for ${options.url.includes('twitch.tv') ? 'Twitch' : 'YouTube Live'} stream`, 'PlayerService');
        } else {
          // Start MPV directly
          const playerProcess = await this.startMpvProcess(options);
          this.setupStreamHealthCheck(screen, playerProcess);
          this.streams.set(screen, {
            id: Date.now(),
            screen: screen,
            url: options.url,
            quality: options.quality || 'best',
            status: 'playing',
            volume: options.volume || 0,
            process: playerProcess,
            platform: options.url.includes('youtube.com') ? 'youtube' : 'twitch'
          });

          return {
            screen,
            message: 'Stream started successfully',
            success: true
          };
        }

        logger.info(`Logging MPV output to ${mpvLogPath}`, 'PlayerService');

        const spawnOptions: SpawnOptions & { nice?: number } = {
          nice: this.getProcessPriority(),
          env: {
            ...process.env,
            MPV_HOME: undefined,
            XDG_CONFIG_HOME: undefined,
            DISPLAY: process.env.DISPLAY || ':0',
            SDL_VIDEODRIVER: 'x11'  // Force SDL to use X11
          },
          shell: false  // Don't use shell to avoid signal handling issues
        };

        // Clean up any existing IPC socket
        const ipcPath = path.join('/tmp', `mpv-ipc-${screen}`);
        try {
          if (fs.existsSync(ipcPath)) {
            fs.unlinkSync(ipcPath);
          }
        } catch (error) {
          logger.warn(`Failed to clean up IPC socket at ${ipcPath}: ${error instanceof Error ? error.message : String(error)}`, 'PlayerService');
        }

        // Log the full command for debugging
        const fullCommand = [command, ...args].join(' ');
        logger.info(`Full command: ${fullCommand}`, 'PlayerService');

        // Use spawnOptions when spawning the process
        const playerProcess = spawn(command, args, spawnOptions);

        // Add error handler for the process itself
        playerProcess.on('error', (error) => {
          logger.error(
            `Process error for screen ${screen}: ${error.message}`,
            'PlayerService',
            error
          );
          this.errorCallback?.({
            screen: screen,
            error: `Process error: ${error.message}`,
            code: -2
          });
        });

        // Add startup monitoring with improved error handling
        let hasStarted = false;
        let startupError: string | undefined = undefined;
        const startupTimeout = setTimeout(() => {
          if (!hasStarted && playerProcess.exitCode === null) {
            startupError = 'Process failed to start properly within timeout';
            logger.error(
              `Process for screen ${screen} failed to start properly within timeout`,
              'PlayerService'
            );
            try {
              playerProcess.kill('SIGKILL');
            } catch {
              // Process might already be gone
            }
          }
          // Clear startup lock on timeout
          this.startupLocks.set(screen, false);
        }, 10000); // 10 second timeout

        // Handle process output with improved error detection
        if (playerProcess.stdout) {
          playerProcess.stdout.on('data', (data: Buffer) => {
            try {
              const output = data.toString('utf8').trim();
              // Only log if it contains printable characters
              if (output && /[\x20-\x7E]/.test(output)) {
                // Check for common MPV startup errors
                if (output.includes('Failed to initialize') || 
                    output.includes('cannot open display') ||
                    output.includes('Could not connect to X server') ||
                    output.includes('failed to open display') ||
                    output.includes('failed to initialize OpenGL') ||
                    output.includes('failed to create window')) {
                  startupError = output;
                  logger.error(`MPV startup error: ${output}`, 'PlayerService');
                  try {
                    playerProcess.kill('SIGKILL');
                  } catch {
                    // Process might already be gone
                  }
                  // Clear startup lock on error
                  this.startupLocks.set(screen, false);
                  return;
                }
                
                // Mark as started only if we get valid output and no startup error
                if (!startupError && !output.includes('error')) {
                  hasStarted = true;
                  // Clear startup lock on successful start
                  this.startupLocks.set(screen, false);
                  logger.debug(`[${command}-${screen}-stdout] ${output}`, 'PlayerService');
                  this.outputCallback?.({
                    screen: screen,
                    data: output,
                    type: 'stdout'
                  });
                }
              }
            } catch (error: unknown) {
              // Log error details for debugging
              logger.debug(
                `Received binary or invalid UTF-8 data on stdout for screen ${screen}: ${error instanceof Error ? error.message : String(error)}`,
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
                // Check for critical errors in stderr
                if (output.includes('Failed to initialize') || 
                    output.includes('cannot open display') ||
                    output.includes('Could not connect to X server')) {
                  startupError = output;
                  logger.error(`MPV startup error: ${output}`, 'PlayerService');
                  try {
                    playerProcess.kill('SIGKILL');
                  } catch {
                    // Process might already be gone
                  }
                  // Clear startup lock on error
                  this.startupLocks.set(screen, false);
                  return;
                }

                logger.debug(`[${command}-${screen}-stderr] ${output}`, 'PlayerService');
                this.errorCallback?.({
                  screen: screen,
                  error: output
                });
              }
            } catch (error: unknown) {
              // Log error details for debugging
              logger.debug(
                `Received binary or invalid UTF-8 data on stderr for screen ${screen}: ${error instanceof Error ? error.message : String(error)}`,
                'PlayerService'
              );
            }
          });
        }

        // Handle process exit with improved error handling
        playerProcess.on('exit', (code: number | null, signal: string | null) => {
          clearTimeout(startupTimeout); // Clear the startup timeout
          logger.info(`Process for screen ${screen} exited with code ${code}${signal ? ` (signal: ${signal})` : ''}`, 'PlayerService');
          
          // Clear health check on exit
          this.clearHealthCheck(screen);
          
          if (!hasStarted || startupError) {
            const errorMessage = startupError || `Process exited before properly starting (code: ${code}, signal: ${signal})`;
            logger.error(
              `${errorMessage}. Command: ${command} ${args.join(' ')}`,
              'PlayerService'
            );
            this.errorCallback?.({
              screen: screen,
              error: errorMessage,
              code: -3
            });
            return;
          }

          // Handle normal exit
          if (code !== 0 && code !== null && !this.manuallyClosedScreens.has(screen)) {
            // Add more detailed error logging
            logger.error(
              `Stream process crashed with code ${code} on screen ${screen}. ` +
              `URL: ${options.url}, Quality: ${options.quality}`, 
              'PlayerService'
            );
            
            const retryCount = this.streamRetries.get(screen) || 0;
            
            if (retryCount < this.MAX_RETRIES) {
              // Add exponential backoff
              const delay = this.RETRY_INTERVAL * Math.pow(2, retryCount);
              this.streamRetries.set(screen, retryCount + 1);
              
              logger.info(
                `Attempting retry ${retryCount + 1}/${this.MAX_RETRIES} in ${delay/1000}s...`,
                'PlayerService'
              );
              
              setTimeout(async () => {
                try {
                  // First try with same quality
                  await this.startStream(options);
                } catch (error) {
                  // If that fails, try fallback quality
                  if (!await this.tryFallbackQuality(options)) {
                    logger.error(
                      `Failed to restart stream on screen ${screen} with all quality options`,
                      'PlayerService',
                      error instanceof Error ? error : new Error(String(error))
                    );
                  }
                }
              }, delay);
            } else {
              logger.error(
                `Max retries (${this.MAX_RETRIES}) reached for screen ${screen}. ` +
                'Attempting to fetch new stream from queue...',
                'PlayerService'
              );
              this.streamRetries.delete(screen);
              
              // Try to get a new stream from the queue
              this.errorCallback?.({
                screen: screen,
                error: 'Max retries reached, fetching new stream',
                code: -1
              });
            }
          }

          // Clean up
          this.streams.delete(screen);
        });

        // Store stream information
        const instance: StreamInstance = {
          id: screen,
          screen: screen,
          process: playerProcess,
          url: options.url,
          quality: options.quality || 'best',
          platform: options.url.includes('youtube.com') ? 'youtube' : 'twitch',
          status: 'playing',
          volume: screenConfig.volume || this.config.player.defaultVolume
        };

        this.streams.set(screen, instance);

        // Set up stream refresh timer
        this.setupStreamRefresh(screen, options);

        // Set up inactive timer
        this.setupInactiveTimer(screen);

        // Store stream start time
        this.streamStartTimes.set(screen, Date.now());

        // Set up stream health monitoring
        this.setupStreamHealthCheck(screen, playerProcess);

        return {
          screen: screen,
          message: `Stream started on screen ${screen}`,
          success: true
        };
      } catch (error) {
        // Clear startup lock on error
        this.startupLocks.set(screen, false);
        logger.error(`Failed to start stream: ${error instanceof Error ? error.message : String(error)}`, 'PlayerService');
        return {
          success: false,
          screen: options.screen || 1,
          message: `Failed to start stream: ${error instanceof Error ? error.message : String(error)}`
        };
      }
    } catch (error) {
      // Clear startup lock on error
      this.startupLocks.set(screen, false);
      logger.error(`Failed to start stream: ${error instanceof Error ? error.message : String(error)}`, 'PlayerService');
      return {
        success: false,
        screen: options.screen || 1,
        message: `Failed to start stream: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  async stopStream(screen: number, isManualStop: boolean = false): Promise<boolean> {
    const stream = this.streams.get(screen);
    if (!stream) return false;

    try {
        // Set flags to prevent restart
        if (isManualStop) {
            this.manuallyClosedScreens.add(screen);
        }

        // Kill the process
        if (stream.process) {
            try {
                stream.process.kill('SIGINT');
                
                // Wait for process to exit
                await new Promise<void>((resolve) => {
                    const timeout = setTimeout(() => {
                        try {
                            stream.process?.kill('SIGKILL');
                        } catch {
                            // Process might already be gone
                        }
                        resolve();
                    }, 5000);

                    stream.process?.once('exit', () => {
                        clearTimeout(timeout);
                        resolve();
                    });
                });
            } catch {
                // Process might already be gone
            }
        }

        // Clean up resources
        this.clearStreamRefresh(screen);
        this.clearInactiveTimer(screen);
        this.clearHealthCheck(screen);
        this.streams.delete(screen);
        this.streamRetries.delete(screen);

        return true;
    } catch (error) {
        logger.error(`Error stopping stream on screen ${screen}`, 'PlayerService', error as Error);
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
    this.clearHealthCheck(screen);
    this.clearStreamRefresh(screen);
    this.clearInactiveTimer(screen);
    this.streamRetries.delete(screen);
    this.streamStartTimes.delete(screen);
    this.lastStreamEndTime.set(screen, Date.now());
    
    // If force_player is enabled and the screen is enabled, restart the player
    const forcePlayer = this.config.player.force_player as boolean | undefined;
    if (forcePlayer) {
      const screenConfig = this.config.player.screens.find(s => s.screen === screen);
      if (screenConfig && screenConfig.enabled && !this.manuallyClosedScreens.has(screen)) {
        logger.info(`Force player is enabled, restarting player for screen ${screen}`, 'PlayerService');
        // Wait a short time before restarting to avoid rapid restart cycles
        setTimeout(async () => {
          try {
            await this.startStream({
              url: 'about:blank', // Use a blank page as placeholder
              screen,
              quality: screenConfig.quality || this.config.player.defaultQuality,
              volume: screenConfig.volume !== undefined ? screenConfig.volume : this.config.player.defaultVolume,
              windowMaximized: screenConfig.windowMaximized !== undefined ? screenConfig.windowMaximized : this.config.player.windowMaximized
            });
            logger.info(`Player restarted for screen ${screen}`, 'PlayerService');
          } catch (error) {
            logger.error(`Failed to restart player for screen ${screen}: ${error instanceof Error ? error.message : String(error)}`, 'PlayerService');
          }
        }, 2000);
      }
    }
    
    // Check if all screens are closed
    if (this.streams.size === 0) {
      logger.info('All players closed, performing cleanup', 'PlayerService');
      this.cleanup();
    }
    
    this.events.emit('stream:end', screen);
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

  private setupStreamHealthCheck(screen: number, playerProcess: ChildProcess) {
    // Clear any existing health check
    this.clearHealthCheck(screen);

    // Set up new health check interval
    const healthCheck = setInterval(() => {
      // Skip health check if process is already gone
      if (!playerProcess.pid) {
        this.clearHealthCheck(screen);
        return;
      }

      // Check if process is still running
      try {
        process.kill(playerProcess.pid, 0);
      } catch (error) {
        logger.warn(
          `Stream process on screen ${screen} appears to be unresponsive: ${error instanceof Error ? error.message : String(error)}`, 
          'PlayerService'
        );
        // Force restart the stream
        const streamInfo = this.streams.get(screen);
        if (streamInfo) {
          this.stopStream(screen).then(() => {
            this.startStream({ 
              screen, 
              url: streamInfo.url,
              quality: streamInfo.quality,
              volume: streamInfo.volume
            }).catch(error => {
              logger.error(
                `Failed to restart unresponsive stream on screen ${screen}: ${error instanceof Error ? error.message : String(error)}`,
                'PlayerService',
                error instanceof Error ? error : new Error(String(error))
              );
            });
          });
        }
      }
    }, 60000); // Check every minute

    this.healthCheckIntervals.set(screen, healthCheck);
  }

  private clearHealthCheck(screen: number) {
    const interval = this.healthCheckIntervals.get(screen);
    if (interval) {
      clearInterval(interval);
      this.healthCheckIntervals.delete(screen);
    }
  }

  private async tryFallbackQuality(options: StreamOptions & { screen: number }): Promise<boolean> {
    const qualities = ['best', 'high', 'medium', 'low'];
    const currentQuality = options.quality || 'best';
    const currentIndex = qualities.indexOf(currentQuality);
    
    if (currentIndex < qualities.length - 1) {
      const nextQuality = qualities[currentIndex + 1];
      logger.info(
        `Attempting fallback quality ${nextQuality} for screen ${options.screen}`,
        'PlayerService'
      );
      
      try {
        await this.startStream({
          ...options,
          quality: nextQuality
        });
        return true;
      } catch (error) {
        logger.error(
          `Failed to start stream with fallback quality ${nextQuality}`,
          'PlayerService',
          error instanceof Error ? error : new Error(String(error))
        );
        return false;
      }
    }
    return false;
  }

  async cleanup() {
    if (this.isShuttingDown) {
      logger.debug('Cleanup already in progress, skipping', 'PlayerService');
      return;
    }

    this.isShuttingDown = true;
    this.forceCleanup();
  }

  private forceCleanup(): void {
    logger.info('Force cleaning up all player processes', 'PlayerService');
    
    // Clear all health check intervals
    for (const [screen, interval] of this.healthCheckIntervals) {
      clearInterval(interval);
      this.healthCheckIntervals.delete(screen);
    }

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

  async ensurePlayersRunning(): Promise<void> {
    // Check if force_player is enabled
    const forcePlayer = this.config.player.force_player as boolean | undefined;
    if (!forcePlayer) {
        logger.debug('force_player is disabled, not ensuring players are running', 'PlayerService');
        return;
    }
    
    logger.info('Force player is enabled, ensuring all enabled screens have players running', 'PlayerService');
    
    // Get all enabled screens
    const enabledScreens = this.config.player.screens.filter(s => s.enabled);
    
    if (enabledScreens.length === 0) {
        logger.warn('No enabled screens found in configuration', 'PlayerService');
        return;
    }
    
    logger.info(`Found ${enabledScreens.length} enabled screens: ${enabledScreens.map(s => s.screen).join(', ')}`, 'PlayerService');
    
    // First, clean up any existing processes
    for (const screen of enabledScreens) {
        await this.killExistingProcesses(screen.screen);
    }
    
    // Wait a bit to ensure all processes are cleaned up
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Start players with delay between each screen
    for (const screen of enabledScreens) {
        // Skip if screen was manually closed
        if (this.manuallyClosedScreens.has(screen.screen)) {
            logger.debug(`Screen ${screen.screen} was manually closed, skipping`, 'PlayerService');
            continue;
        }
        
        logger.info(`Starting player for screen ${screen.screen}`, 'PlayerService');
        try {
            // Start MPV directly in idle mode
            const args = [
                '--idle=yes',
                '--force-window=yes',
                '--keep-open=yes',
                '--no-terminal',
                `--title=LiveLink-${screen.screen}`,
                `--geometry=${screen.width}x${screen.height}+${screen.x}+${screen.y}`,
                `--volume=${screen.volume !== undefined ? screen.volume : this.config.player.defaultVolume}`,
                `--input-ipc-server=/tmp/mpv-ipc-${screen.screen}`,
                `--log-file=${path.join(this.BASE_LOG_DIR, 'mpv', `mpv-screen${screen.screen}-${Date.now()}.log`)}`,
                `--script=${path.join(process.cwd(), 'scripts', 'livelink.lua')}`,
                `--script-opts=screen=${screen.screen}`,
                screen.windowMaximized ? '--window-maximized=yes' : '--window-maximized=no'
            ];

            // Add MPV config settings
            if (this.config.mpv) {
                Object.entries(this.config.mpv).forEach(([key, value]) => {
                    if (value !== null && value !== undefined && key !== 'priority') {
                        args.push(`--${key}=${value}`);
                    }
                });
            }

            const playerProcess = spawn(this.mpvPath, args, {
                env: {
                    ...process.env,
                    MPV_HOME: undefined,
                    XDG_CONFIG_HOME: undefined,
                    DISPLAY: process.env.DISPLAY || ':0',
                    SDL_VIDEODRIVER: 'x11'
                },
                shell: false
            });

            this.setupStreamHealthCheck(screen.screen, playerProcess);
            this.streams.set(screen.screen, {
                id: Date.now(),
                screen: screen.screen,
                url: '',
                quality: screen.quality || this.config.player.defaultQuality,
                status: 'stopped',
                volume: screen.volume !== undefined ? screen.volume : this.config.player.defaultVolume,
                process: playerProcess,
                platform: 'twitch'  // Default to twitch as placeholder
            });

            // Wait for the player to be ready
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error(`Timeout waiting for player on screen ${screen.screen} to be ready`));
                }, 10000);

                const checkInterval = setInterval(() => {
                    const stream = this.streams.get(screen.screen);
                    if (stream?.process && !stream.process.killed) {
                        clearTimeout(timeout);
                        clearInterval(checkInterval);
                        resolve();
                    }
                }, 500);
            });

            logger.info(`Player started successfully for screen ${screen.screen}`, 'PlayerService');
            
            // Add delay between starting each screen
            await new Promise(resolve => setTimeout(resolve, 2000));
            
        } catch (error) {
            logger.error(
                `Failed to start player for screen ${screen.screen}: ${error instanceof Error ? error.message : String(error)}`,
                'PlayerService',
                error instanceof Error ? error : new Error(String(error))
            );
            
            // Try to clean up if startup failed
            await this.killExistingProcesses(screen.screen);
        }
    }
  }

  private async killExistingProcesses(screen: number): Promise<void> {
    // Don't kill if there's a startup in progress
    if (this.startupLocks.get(screen)) {
      logger.info(`Stream startup in progress for screen ${screen}, skipping process kill`, 'PlayerService');
      return;
    }

    try {
      // Find MPV processes for this screen
      const pids = await new Promise<string[]>((resolve, reject) => {
        exec(`pgrep -f "mpv.*--script-opts=screen=${screen}"`, (error, stdout) => {
          if (error && error.code !== 1) { // code 1 means no processes found
            reject(error);
            return;
          }
          resolve(stdout.trim().split('\n').filter(Boolean));
        });
      });

      // Kill each process
      await Promise.all(pids.map(async (pid) => {
        try {
          process.kill(parseInt(pid), 'SIGINT');
          logger.info(`Killed process ${pid} for screen ${screen}`, 'PlayerService');
          
          // Force kill after 1 second if still running
          await new Promise<void>((resolve) => {
            setTimeout(() => {
              try {
                process.kill(parseInt(pid), 0); // Check if process exists
                process.kill(parseInt(pid), 'SIGKILL');
                logger.info(`Force killed process ${pid} for screen ${screen}`, 'PlayerService');
              } catch {
                // Process already gone
              }
              resolve();
            }, 1000);
          });
        } catch (error) {
          logger.warn(`Failed to kill process ${pid}: ${error instanceof Error ? error.message : String(error)}`, 'PlayerService');
        }
      }));
    } catch (error) {
      logger.error(`Error killing existing processes for screen ${screen}: ${error instanceof Error ? error.message : String(error)}`, 'PlayerService');
    }
  }

  private async startMpvProcess(options: StreamOptions & { screen: number }): Promise<ChildProcess> {
    const args = this.getMpvArgs(options);
    const env = { ...process.env };

    // Try to detect the X display
    if (!env.DISPLAY) {
      const display = `:${99 + options.screen}`;
      await this.startXvfb(display, env);
    }

    // If we still don't have a display, try wayland
    if (!env.DISPLAY && process.env.WAYLAND_DISPLAY) {
      args.splice(args.indexOf('--vo=gpu'), 1, '--vo=gpu', '--gpu-context=wayland');
    }

    logger.info(`Starting ${this.mpvPath} directly for video playback`, 'PlayerService');
    logger.info(`Logging MPV output to ${args.find(arg => arg.startsWith('--log-file='))?.split('=')[1]}`, 'PlayerService');
    logger.info(`Full command: ${this.mpvPath} ${args.join(' ')}`, 'PlayerService');

    const playerProcess = spawn(this.mpvPath, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    return playerProcess;
  }

  private async startXvfb(display: string, env: NodeJS.ProcessEnv): Promise<void> {
    try {
      await new Promise<void>((resolve, reject) => {
        exec(`Xvfb ${display} -screen 0 1920x1080x24 -nolisten tcp`, (error) => {
          if (error) {
            logger.error(`Failed to start Xvfb: ${error.message}`, 'PlayerService');
            reject(error);
          } else {
            resolve();
          }
        });
      });
      env.DISPLAY = display;
      logger.info(`Started Xvfb on display ${display}`, 'PlayerService');
    } catch (error) {
      logger.error(`Failed to start Xvfb on display ${display}: ${error instanceof Error ? error.message : String(error)}`, 'PlayerService');
      throw error;
    }
  }
} 
