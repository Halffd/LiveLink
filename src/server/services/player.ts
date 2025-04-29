import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import type { Config, StreamlinkConfig, ScreenConfig } from '../../types/stream.js';
import type { StreamOutput, StreamError, StreamResponse, StreamEnd } from '../../types/stream_instance.js';
import { logger } from './logger.js';
import { exec, execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';

interface LocalStreamInstance {
	id: number;
	screen: number;
	url: string;
	quality: string;
	status: string;
	volume: number;
	process: ChildProcess;
	platform: 'youtube' | 'twitch';
	title?: string;
	startTime?: number;
	options: StreamOptions & { screen: number };
}

export interface StreamOptions {
	screen: number;
	config: ScreenConfig;
	url: string;
	isLive?: boolean;
	isWatched?: boolean;
	isRetry?: boolean;
	title?: string;
	viewerCount?: number;
	startTime?: number;
	quality?: string;
	volume?: number;
	windowMaximized?: boolean;
}

export class PlayerService {
	private readonly BASE_LOG_DIR: string;
	private readonly MAX_RETRIES = 3; // Maximum number of retries
	private readonly MAX_NETWORK_RETRIES = 3; // Maximum network-specific retries
	private readonly RETRY_INTERVAL = 100; // 100ms (reduced from 200ms)
	private readonly NETWORK_RETRY_INTERVAL = 1000; // 1 second (reduced from 2 seconds)
	private readonly MAX_BACKOFF_TIME = 15000; // 15 seconds (reduced from 30 seconds)
	private readonly INACTIVE_RESET_TIMEOUT = 60 * 1000; // 1 minute (reduced from 2 minutes)
	private readonly STARTUP_TIMEOUT = 90000;
	private readonly SHUTDOWN_TIMEOUT = 500; // 500ms (reduced from 1000ms)
	private readonly SCRIPTS_PATH: string;
	private streams: Map<number, LocalStreamInstance> = new Map();
	private streamRetries: Map<number, number> = new Map();
	private networkRetries: Map<number, number> = new Map(); // Track network-specific retries separately
	private lastNetworkError: Map<number, number> = new Map(); // Track when the last network error occurred
	private streamStartTimes: Map<number, number> = new Map();
	private inactiveTimers: Map<number, NodeJS.Timeout> = new Map();
	private healthCheckIntervals: Map<number, NodeJS.Timeout> = new Map();
	private startupLocks: Map<number, boolean> = new Map();
	private manuallyClosedScreens: Set<number> = new Set();
	private disabledScreens: Set<number> = new Set();
	private ipcPaths: Map<number, string> = new Map();
	private isNetworkError: Map<number, boolean> = new Map(); // Track if error is network-related
	private heartbeatIntervals: Map<number, NodeJS.Timeout> = new Map();
	private readonly HEARTBEAT_INTERVAL = 15000; // 15 seconds
	private readonly HEARTBEAT_TIMEOUT = 5000; // 5 seconds
	private heartbeatStatuses: Map<number, boolean> = new Map(); // true = alive, false = unresponsive

	private config: Config;
	private mpvPath: string;
	private isShuttingDown = false;
	private events = new EventEmitter();
	private outputCallback?: (data: StreamOutput) => void;
	private errorCallback?: (data: StreamError) => void;
	private endCallback?: (data: StreamEnd) => void;

	public readonly DUMMY_SOURCE = '';  // Empty string instead of black screen URL

	private readonly streamlinkConfig: StreamlinkConfig;
	private readonly retryTimers: Map<number, NodeJS.Timeout>;

	constructor(config: Config) {
		this.config = config;
		this.streamlinkConfig = config.streamlink || {
			path: 'streamlink',
			options: {},
			http_header: {}
		};
		this.streams = new Map();
		this.ipcPaths = new Map();
		this.disabledScreens = new Set();
		this.retryTimers = new Map();

		// Set up paths
		this.BASE_LOG_DIR = path.join(process.cwd(), 'logs');
		this.SCRIPTS_PATH = path.join(process.cwd(), 'scripts/mpv');
		this.mpvPath = 'mpv';

		// Create log directory if it doesn't exist
		if (!fs.existsSync(this.BASE_LOG_DIR)) {
			fs.mkdirSync(this.BASE_LOG_DIR, { recursive: true });
		}

		this.initializeDirectories();
		this.registerSignalHandlers();
	}

	private initializeDirectories(): void {
		try {
			// Create log directories
			const logDirs = ['mpv', 'streamlink'].map((dir) => path.join(this.BASE_LOG_DIR, dir));
			logDirs.forEach((dir) => {
				if (!fs.existsSync(dir)) {
					fs.mkdirSync(dir, { recursive: true });
				}
			});

			// Create .livelink directory
			const homedir = process.env.HOME || process.env.USERPROFILE;
			if (homedir) {
				const livelinkDir = path.join(homedir, '.livelink');
				if (!fs.existsSync(livelinkDir)) {
					fs.mkdirSync(livelinkDir, { recursive: true });
				}
			}

			// Clean old logs
			this.clearOldLogs(path.join(this.BASE_LOG_DIR, 'mpv'));
			this.clearOldLogs(path.join(this.BASE_LOG_DIR, 'streamlink'));
		} catch (error) {
			logger.error(
				'Failed to initialize directories',
				'PlayerService',
				error instanceof Error ? error : new Error(String(error))
			);
		}
	}

	private clearOldLogs(directory: string): void {
		try {
			const files = fs.readdirSync(directory);
			const now = Date.now();
			const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days

			for (const file of files) {
				const filePath = path.join(directory, file);
				const stats = fs.statSync(filePath);
				const age = now - stats.mtime.getTime();

				if (age > maxAge) {
					fs.unlinkSync(filePath);
					logger.debug(`Deleted old log file: ${filePath}`, 'PlayerService');
				}
			}
		} catch (error) {
			logger.error(
				`Failed to clean old logs in ${directory}`,
				'PlayerService',
				error instanceof Error ? error : new Error(String(error))
			);
		}
	}

	private findMpvPath(): string {
		try {
			return execSync('which mpv').toString().trim();
		} catch (error) {
			logger.error(
				'Failed to find MPV',
				'PlayerService',
				error instanceof Error ? error : new Error(String(error))
			);
			return 'mpv';
		}
	}

	private registerSignalHandlers(): void {
		['SIGINT', 'SIGTERM', 'SIGQUIT'].forEach((signal) => {
			process.once(signal, () => {
				if (!this.isShuttingDown) {
					logger.info(`Received ${signal} signal`, 'PlayerService');
					this.cleanup();
				}
			});
		});
	}

	async startStream(options: StreamOptions & { screen: number }): Promise<StreamResponse> {
		try {
			// Log attempt with URL for better debugging
			logger.info(`Attempting to start stream on screen ${options.screen}: ${options.url}`, 'PlayerService');

			// Check if screen is disabled
			if (this.disabledScreens.has(options.screen)) {
				logger.warn(`Attempted to start stream on disabled screen ${options.screen}`, 'PlayerService');
				return {
					screen: options.screen,
					success: false,
					error: 'Screen is disabled'
				};
			}
			logger.info(`Checking if screen is disabled for screen ${options.screen}`, 'PlayerService');
			// Check for maximum streams limit
			const activeStreams = Array.from(this.streams.values()).filter(s => {
				logger.info(`Process: ${s.process?.pid} Running: ${this.isProcessRunning(s.process?.pid)}`, 'PlayerService');
				return s.process && this.isProcessRunning(s.process.pid)
			});
			logger.info(`Active streams: ${activeStreams.length}`, 'PlayerService');
			if (activeStreams.length >= this.config.player.maxStreams) {
				logger.warn(`Maximum number of streams (${this.config.player.maxStreams}) reached, active: ${activeStreams.length}`, 'PlayerService');
				return {
					screen: options.screen,
					success: false,
					error: `Maximum number of streams (${this.config.player.maxStreams}) reached`
				};
			}
			logger.info(`Checking for maximum streams limit for screen ${options.screen}`, 'PlayerService');
			// Check if we're already starting a stream on this screen
			if (this.startupLocks.get(options.screen)) {
				logger.warn(`Stream startup already in progress for screen ${options.screen}`, 'PlayerService');
				return {
					screen: options.screen,
					success: false,
					error: 'Stream startup already in progress'
				};
			}
			logger.info(`Checking startup lock for screen ${options.screen}`, 'PlayerService');
			// Clear any stuck startup locks (if they've been set for > 30 seconds)
			for (const [screen, locked] of this.startupLocks.entries()) {
				if (locked) {
					logger.warn(`Found stuck startup lock for screen ${screen}, clearing it`, 'PlayerService');
					this.startupLocks.set(screen, false);
				}
			}

			// Set startup lock
			this.startupLocks.set(options.screen, true);
			logger.info(`Set startup lock for screen ${options.screen}`, 'PlayerService');

			// Create a timeout to clear the startup lock if something goes wrong
			const lockTimeout = setTimeout(() => {
				logger.error(`Startup lock timeout for screen ${options.screen}`, 'PlayerService');
				this.startupLocks.set(options.screen, false);
			}, 45000);

			try {
				// Stop any existing stream first
				await this.stopStream(options.screen);

				// Initialize directories if needed
				this.initializeDirectories();

				// Initialize IPC path
				const homedir = process.env.HOME || process.env.USERPROFILE;
				const ipcPath = homedir
					? path.join(homedir, '.livelink', `mpv-ipc-${options.screen}`)
					: `/tmp/mpv-ipc-${options.screen}`;
				this.ipcPaths.set(options.screen, ipcPath);

				logger.info(
					`Starting stream with title: ${options.title}, viewers: ${options.viewerCount}, time: ${options.startTime}, screen: ${options.screen}`,
					'PlayerService'
				);

				// Detect mpv and streamlink paths
				const mpvExists = await this.checkExecutableExists(this.mpvPath);
				if (!mpvExists) {
					logger.error(`MPV executable not found at path: ${this.mpvPath}`, 'PlayerService');
					throw new Error(`MPV executable not found at ${this.mpvPath}`);
				}

				const streamlinkPath = this.streamlinkConfig.path || 'streamlink';
				const streamlinkExists = await this.checkExecutableExists(streamlinkPath);
				if (this.config.player.preferStreamlink && !streamlinkExists) {
					logger.error(`Streamlink executable not found at path: ${streamlinkPath}`, 'PlayerService');
					throw new Error(`Streamlink executable not found at ${streamlinkPath}`);
				}

				// Log executable paths
				logger.info(`Using MPV at: ${this.mpvPath}`, 'PlayerService');
				if (this.config.player.preferStreamlink) {
					logger.info(`Using Streamlink at: ${streamlinkPath}`, 'PlayerService');
				}

				let playerProcess: ChildProcess;
				if (this.config.player.preferStreamlink || options.url.includes('twitch.tv')) {
					logger.info(`Starting Streamlink for screen ${options.screen}`, 'PlayerService');
					playerProcess = await this.startStreamlinkProcess(options);
				} else {
					logger.info(`Starting MPV for screen ${options.screen}`, 'PlayerService');
					playerProcess = await this.startMpvProcess(options);
				}

				if (!playerProcess || !playerProcess.pid) {
					throw new Error('Failed to start player process - no process or PID returned');
				}

				logger.info(`Player process started with PID ${playerProcess.pid} for screen ${options.screen}`, 'PlayerService');

				// Wait a moment to ensure process has actually started
				await new Promise(resolve => setTimeout(resolve, 1000));

				// Check if the process is still running after initialization
				if (!this.isProcessRunning(playerProcess.pid)) {
					throw new Error(`Player process exited immediately after starting (PID: ${playerProcess.pid})`);
				}

				// Create stream instance and store it
				const streamInstance: LocalStreamInstance = {
					id: Date.now(),
					screen: options.screen,
					url: options.url,
					quality: options.quality || this.config.player.defaultQuality,
					status: 'playing',
					volume: options.volume || 0,
					process: playerProcess,
					platform: options.url.includes('twitch.tv') ? 'twitch' : 'youtube',
					title: options.title,
					startTime: typeof options.startTime === 'string' ? new Date(options.startTime).getTime() : options.startTime,
					options
				};

				// Store stream instance before setting up handlers
				this.streams.set(options.screen, streamInstance);

				// Set up process handlers and monitoring
				this.setupProcessHandlers(playerProcess, options.screen);
				this.setupStreamMonitoring(options.screen, playerProcess, options);

				// Check health immediately
				await this.checkStreamHealth(options.screen);

				// Clear startup lock timeout
				clearTimeout(lockTimeout);

				// Clear startup lock
				this.startupLocks.set(options.screen, false);
				logger.debug(`Cleared startup lock for screen ${options.screen}`, 'PlayerService');

				// Double check the stream was added correctly
				const addedStream = this.streams.get(options.screen);
				if (!addedStream || !addedStream.process || !addedStream.process.pid) {
					throw new Error('Stream was not properly initialized');
				}

				logger.info(`Stream started successfully on screen ${options.screen} with PID ${addedStream.process.pid}`, 'PlayerService');
				return {
					screen: options.screen,
					success: true
				};
			} catch (err) {
				// Clear the timeout and startup lock if we hit an exception
				clearTimeout(lockTimeout);
				this.startupLocks.set(options.screen, false);
				throw err; // Re-throw to be caught by outer try-catch
			}
		} catch (error) {
			// Clear startup lock on error (just to be super sure)
			this.startupLocks.set(options.screen, false);

			// Clean up any partially initialized stream
			this.cleanup_after_stop(options.screen);

			logger.error(
				`Failed to start stream on screen ${options.screen}: ${options.url}`,
				'PlayerService',
				error instanceof Error ? error : new Error(String(error))
			);

			return {
				screen: options.screen,
				success: false,
				error: error instanceof Error ? error.message : String(error)
			};
		}
	}

	private async startMpvProcess(options: StreamOptions & { screen: number }): Promise<ChildProcess> {
		logger.info(`Starting MPV for screen ${options.screen}`, 'PlayerService');

		// Ensure IPC path is initialized
		if (!this.ipcPaths.has(options.screen)) {
			// Create a consistent directory for IPC socket files
			const userHomeDir = process.env.HOME || '/tmp';
			const ipcDir = path.join(userHomeDir, '.livelink');

			// Ensure directory exists
			try {
				if (!fs.existsSync(ipcDir)) {
					fs.mkdirSync(ipcDir, { recursive: true });
				}
			} catch (error) {
				logger.error(`Failed to create IPC directory ${ipcDir}`, 'PlayerService', error as Error);
			}

			// Use the user's home directory for more reliable socket location
			const ipcPath = path.join(ipcDir, `mpv-ipc-${options.screen}`);
			this.ipcPaths.set(options.screen, ipcPath);

			// Remove existing socket file if it exists
			try {
				if (fs.existsSync(ipcPath)) {
					fs.unlinkSync(ipcPath);
					logger.info(`Removed existing socket file at ${ipcPath}`, 'PlayerService');
				}
			} catch (error) {
				// Ignore errors if file doesn't exist or can't be removed
				logger.warn(`Could not remove existing socket at ${ipcPath}`, 'PlayerService',
					error instanceof Error ? error.message : String(error));
			}
		}

		const args = this.getMpvArgs(options);
		const env = this.getProcessEnv();

		logger.info(`Starting MPV with command: ${this.mpvPath} ${args.join(' ')}`, 'PlayerService');
		logger.debug(`MPV args: ${args.join(' ')}`, 'PlayerService');
		const mpvProcess = spawn(this.mpvPath, args, {
			env,
			stdio: ['ignore', 'pipe', 'pipe']
		});

		// Set up logging for the process
		if (mpvProcess.stdout) {
			mpvProcess.stdout.on('data', (data: Buffer) => {
				logger.debug(`MPV stdout (screen ${options.screen}): ${data.toString().trim()}`, 'PlayerService');
			});
		}

		if (mpvProcess.stderr) {
			mpvProcess.stderr.on('data', (data: Buffer) => {
				logger.debug(`MPV stderr (screen ${options.screen}): ${data.toString().trim()}`, 'PlayerService');
			});
		}

		// Wait a moment to let MPV create the socket
		await new Promise(resolve => setTimeout(resolve, 1000)); // Increased from 500ms

		return mpvProcess;
	}

	private async startStreamlinkProcess(
		options: StreamOptions & { screen: number }
	): Promise<ChildProcess> {
		const args = this.getStreamlinkArgs(options.url, options);
		const env = this.getProcessEnv();
		logger.info(`Streamlink args: streamlink ${args.join(' ')}`, 'PlayerService');
		try {
			const process = spawn(this.streamlinkConfig.path || 'streamlink', args, {
				env,
				stdio: ['ignore', 'pipe', 'pipe']
			});

			return new Promise((resolve, reject) => {
				let errorOutput = '';
				let hasStarted = false;
				const startTimeout = setTimeout(() => {
					const error = new Error('Stream start timeout exceeded');
					this.logError(
						`Stream start timeout on screen ${options.screen}`,
						'PlayerService',
						error
					);
					process.kill();
					reject(error);
				}, this.STARTUP_TIMEOUT);

				const onData = (data: Buffer) => {
					const output = data.toString();
					if (output.includes('Starting player')) {
						hasStarted = true;
						clearTimeout(startTimeout);
						resolve(process);
					}
					// Check for common error patterns
					if (output.toLowerCase().includes('error')) {
						errorOutput += output + '\n';
					}
					logger.info(`Streamlink output: ${output}`, 'PlayerService');
				};

				const onError = (error: Error) => {
					clearTimeout(startTimeout);
					this.logError(
						`Failed to start streamlink for screen ${options.screen}`,
						'PlayerService',
						error
					);
					reject(error);
				};

				const onExit = (code: number | null) => {
					clearTimeout(startTimeout);
					if (!hasStarted) {
						let errorMessage = 'Stream failed to start';

						// Enhanced error detection
						if (errorOutput.toLowerCase().includes('members-only')) {
							errorMessage = 'Stream unavailable (members-only content)';
						} else if (errorOutput.toLowerCase().includes('no playable streams')) {
							errorMessage = 'No playable streams found';
						} else if (errorOutput.toLowerCase().includes('404')) {
							errorMessage = 'Stream not found (404)';
						} else if (errorOutput.toLowerCase().includes('private')) {
							errorMessage = 'Stream is private';
						} else if (code === 1) {
							errorMessage = 'Stream unavailable (possibly members-only content)';
						} else if (code === 130) {
							errorMessage = 'Stream process interrupted';
						} else if (code === 2) {
							errorMessage = 'Stream unavailable or invalid URL';
						}

						const error = new Error(errorMessage);
						this.logError(
							`Stream failed to start on screen ${options.screen} (code ${code})`,
							'PlayerService',
							error
						);
						reject(error);
					}
				};

				process.stdout.on('data', onData);
				process.stderr.on('data', (data: Buffer) => {
					errorOutput += data.toString() + '\n';
					onData(data);
				});
				process.on('error', onError);
				process.on('exit', onExit);
			});
		} catch (error) {
			this.logError(
				`Failed to spawn streamlink process for screen ${options.screen}`,
				'PlayerService',
				error
			);
			throw error;
		}
	}

	private setupProcessHandlers(process: ChildProcess, screen: number): void {
		let hasEndedStream = false;
		let cleanupTimeout: NodeJS.Timeout | null = null;

		// Set up heartbeat monitoring
		this.setupHeartbeat(screen);
		
		// Add lock for this specific screen to prevent race conditions
		const initializeHandlerLock = (): boolean => {
			if (hasEndedStream) {
				logger.debug(`Process exit already handled for screen ${screen}, ignoring duplicate event`, 'PlayerService');
				return false;
			}
			
			const stream = this.streams.get(screen);
			if (!stream || stream.status === 'stopping') {
				logger.debug(`Stream on screen ${screen} already stopping, ignoring duplicate exit event`, 'PlayerService');
				return false;
			}
			
			// Mark as handled
			hasEndedStream = true;
			return true;
		};

		const cleanup = () => {
			if (cleanupTimeout) {
				clearTimeout(cleanupTimeout);
				cleanupTimeout = null;
			}

			// Clear monitoring and remove stream from map
			this.clearMonitoring(screen);
			this.streams.delete(screen);
			this.streamRetries.delete(screen);

			// Log the number of active streams after cleanup
			const activeStreams = Array.from(this.streams.values()).filter(s => s.process && this.isProcessRunning(s.process.pid));
			logger.debug(`Cleaned up stream on screen ${screen}. Remaining active streams: ${activeStreams.length}/${this.config.player.maxStreams}`, 'PlayerService');
		};

		const handleStreamEnd = (error: string, code: number = 0) => {
			// Atomically check and set flag to prevent race conditions
			if (!initializeHandlerLock()) {
				return; // Already handled
			}
			
			const stream = this.streams.get(screen);
			const url = stream?.url || '';

			logger.info(`Stream ended on screen ${screen}${url ? ` (${url})` : ''}`, 'PlayerService');

			// Mark the stream as stopping
			if (stream) {
				stream.status = 'stopping';
			}

			// Call error callback with stream URL
			this.errorCallback?.({
				screen,
				error,
				code,
				url,
				moveToNext: true
			});

			// Schedule cleanup after a short delay to ensure all events are processed
			cleanupTimeout = setTimeout(cleanup, 1000);
		};

		if (process.stdout) {
			process.stdout.on('data', (data: Buffer) => {
				const output = data.toString('utf8').trim();
				if (output && /[\x20-\x7E]/.test(output)) {
					// Log YouTube-specific state information
					if (output.includes('[youtube]')) {
						if (output.includes('Post-Live Manifestless mode')) {
							logger.info(`[Screen ${screen}] YouTube stream is in post-live state (ended)`, 'PlayerService');
							handleStreamEnd('Stream ended');
						} else if (output.includes('Downloading MPD manifest')) {
							logger.debug(`[Screen ${screen}] YouTube stream manifest download attempt`, 'PlayerService');
						}
					}

					logger.debug(`[Screen ${screen}] ${output}`, 'PlayerService');
					this.outputCallback?.({
						screen,
						data: output,
						type: 'stdout'
					});

					// Check for different types of stream endings
					if (output.includes('Exiting... (Quit)') ||
						output.includes('Quit') ||
						output.includes('Exiting normally') ||
						output.includes('EOF reached') ||
						output.includes('User stopped playback')) {
						handleStreamEnd('Stream ended');
					}
				}
			});
		}

		if (process.stderr) {
			process.stderr.on('data', (data: Buffer) => {
				const output = data.toString('utf8').trim();
				if (output && /[\x20-\x7E]/.test(output)) {
					// Filter out common PipeWire warnings that don't affect functionality
					if (output.includes('pw.conf') && output.includes('deprecated')) {
						logger.debug(`[Screen ${screen}] PipeWire config warning: ${output}`, 'PlayerService');
					} else {
						// Log YouTube-specific errors with more context
						if (output.includes('youtube-dl failed')) {
							logger.info(
								`[Screen ${screen}] YouTube stream error - may be ended or unavailable: ${output}`,
								'PlayerService'
							);
							handleStreamEnd('Stream ended');
						} else {
							logger.error(`[Screen ${screen}] ${output}`, 'PlayerService');
							handleStreamEnd(output);
						}
					}
				}
			});
		}

		process.on('error', (err: Error) => {
			// Use lockout to prevent race conditions
			if (!initializeHandlerLock()) {
				return; // Already handled
			}
			
			this.logError(`Process error on screen ${screen}`, 'PlayerService', err);
			handleStreamEnd(err.message);
		});

		process.on('exit', (code: number | null) => {
			// Use lockout to prevent race conditions
			if (!initializeHandlerLock()) {
				return; // Already handled
			}
			
			// Get the URL before any cleanup happens
			const stream = this.streams.get(screen);
			const url = stream?.url || '';

			logger.info(`Process exited on screen ${screen} with code ${code}${url ? ` (${url})` : ''}`, 'PlayerService');
			
			// External kill (code null) or missing URL should not be retried to prevent infinite loops
			const isMissingUrl = !url || url.trim() === '';
			const isExternalKill = code === null;

			// Only retry network errors if we have a valid URL and it's not an external kill
			if (this.isNetworkErrorCode(code) && !isMissingUrl && !isExternalKill && stream?.options) {
				const networkRetryCount = this.networkRetries.get(screen) || 0;
				const now = Date.now();
				const lastError = this.lastNetworkError.get(screen) || 0;
				const timeSinceLastError = now - lastError;

				// Reset network retry count if it's been a while since the last error
				if (timeSinceLastError > 2 * 60 * 1000) { // Reduced from 5 minutes to 2 minutes
					logger.info(`Resetting network retry count for screen ${screen} as it's been ${Math.round(timeSinceLastError / 1000)}s since last error`, 'PlayerService');
					this.networkRetries.set(screen, 0);
				}

				// Update last error time
				this.lastNetworkError.set(screen, now);

				// Check if we should retry
				if (networkRetryCount < this.MAX_NETWORK_RETRIES) {
					// Calculate backoff time with exponential backoff
					const backoffTime = Math.min(this.NETWORK_RETRY_INTERVAL * Math.pow(1.5, networkRetryCount), this.MAX_BACKOFF_TIME);

					logger.info(`Network error detected for ${url} on screen ${screen}, retry ${networkRetryCount + 1}/${this.MAX_NETWORK_RETRIES} in ${Math.round(backoffTime / 1000)}s`, 'PlayerService');

					// Increment retry count
					this.networkRetries.set(screen, networkRetryCount + 1);

					// Clean up but don't emit error yet
					this.cleanup_after_stop(screen);
					this.clearMonitoring(screen);

					// Set up retry timer
					const retryTimer = setTimeout(async () => {
						try {
							logger.info(`Attempting to restart stream ${url} on screen ${screen} after network error`, 'PlayerService');
							await this.startStream({
								...stream.options,
								isRetry: true
							});
						} catch (error) {
							logger.error(`Failed to restart stream after network error on screen ${screen}`, 'PlayerService',
								error instanceof Error ? error : new Error(String(error)));

							// Now emit the error since retry failed
							this.errorCallback?.({
								screen,
								error: `Failed to restart stream after network error: ${error instanceof Error ? error.message : String(error)}`,
								code: code || 0,
								url,
								moveToNext: true
							});
						}
					}, backoffTime);

					// Store the timer
					this.retryTimers.set(screen, retryTimer);
					return; // Don't emit error yet, we're handling it with retry
				} else {
					logger.warn(`Maximum network retries (${this.MAX_NETWORK_RETRIES}) reached for screen ${screen}, giving up`, 'PlayerService');
					// Reset retry count for future attempts
					this.networkRetries.set(screen, 0);
				}
			} else if (isExternalKill) {
				logger.warn(`Process on screen ${screen} was killed externally (code: ${code}), skipping retry`, 'PlayerService');
			} else if (isMissingUrl) {
				logger.warn(`Process on screen ${screen} has no URL, skipping retry to prevent infinite loop`, 'PlayerService');
			}

			// For non-network errors or if max retries reached, clean up and emit error
			this.cleanup_after_stop(screen);
			this.clearMonitoring(screen);

			// Calculate whether to move to next or restart
			const normalExit = code === 0;
			const missingUrl = !url || url.trim() === '';
			const externalKill = code === null;
			const moveToNext = normalExit || missingUrl || externalKill; 
			const shouldRestart = !normalExit && !missingUrl && !externalKill && !this.isShuttingDown;

			// Emit stream error with URL if we have it
			this.errorCallback?.({
				screen,
				error: normalExit ? 'Stream ended normally' : `Stream ended with code ${code}`,
				code: code || 0,
				url,
				moveToNext,
				shouldRestart
			});

			hasEndedStream = true;

			cleanup();
		});
	}

	private setupStreamMonitoring(
		screen: number,
		process: ChildProcess,
		options: StreamOptions
	): void {
		// Setup health check with more lenient timing
		const healthCheck = setInterval(() => {
			if (!process.pid) {
				logger.warn(`No PID found for stream on screen ${screen}`, 'PlayerService');
				return;
			}

			try {
				// Check if process exists and responds
				process.kill(0);

				// Also verify the process hasn't been replaced
				const currentProcess = this.streams.get(screen)?.process;
				if (currentProcess !== process) {
					logger.warn(`Process mismatch detected for screen ${screen}, clearing health check`, 'PlayerService');
					clearInterval(healthCheck);
					this.healthCheckIntervals.delete(screen);
					return;
				}
			} catch (err) {
				// Only restart if the process is actually gone
				if (err && typeof err === 'object' && 'code' in err && err.code === 'ESRCH') {
					logger.warn(`Stream on screen ${screen} appears to be unresponsive`, 'PlayerService');
					this.restartStream(screen, options).catch((err) => {
						logger.error(
							`Failed to restart unresponsive stream on screen ${screen}`,
							'PlayerService',
							err
						);
					});
				}
			}
		}, 15000); // Reduced from 30s to 15s for more responsive detection

		this.healthCheckIntervals.set(screen, healthCheck);

		this.streamStartTimes.set(screen, Date.now());
	}

	private async restartStream(screen: number, options: StreamOptions): Promise<void> {
		// Don't restart if the screen was manually closed
		if (this.manuallyClosedScreens.has(screen)) {
			logger.info(
				`Not restarting stream on screen ${screen} as it was manually closed`,
				'PlayerService'
			);
			return;
		}

		logger.info(`Restarting stream on screen ${screen}: ${options.url}`, 'PlayerService');

		// Stop existing stream and wait for cleanup
		await this.stopStream(screen);

		// Reduced delay to ensure cleanup is complete
		await new Promise((resolve) => setTimeout(resolve, 200)); // Reduced from 500ms to 200ms

		// Double check no existing process before starting new one
		const existingStream = this.streams.get(screen);
		if (existingStream?.process) {
			logger.warn(`Found existing process for screen ${screen}, forcing cleanup`, 'PlayerService');
			try {
				existingStream.process.kill('SIGKILL');
				await new Promise(resolve => setTimeout(resolve, 100)); // Reduced from 200ms to 100ms
			} catch {
				// Process might already be gone
			}
		}

		await this.startStream({ ...options, screen });
	}

	private handleProcessExit(screen: number, code: number | null): void {
		// Get stream info before any cleanup happens
		const stream = this.streams.get(screen);
		
		// Check if stream is already marked as stopping to avoid race conditions
		if (!stream || stream.status === 'stopping') {
			logger.debug(`Stream on screen ${screen} already in stopping state or doesn't exist, ignoring duplicate exit handling`, 'PlayerService');
			return;
		}
		
		const url = stream?.url || '';
		const options = stream?.options;

		// IMPORTANT: Set state flag immediately to prevent race conditions
		// Flag this stream as being processed for exit to prevent duplicate handling
		if (stream) {
			stream.status = 'stopping';
			// Store process and then remove reference to prevent duplicate exit handling
			// @ts-ignore - Deliberately setting to null to prevent duplicate handling
			stream.process = null;
		}

		// Log with URL for better tracking
		logger.info(`Process exited on screen ${screen} with code ${code}${url ? ` (${url})` : ''}`, 'PlayerService');

		// Check if this is a network-related error
		const isNetworkError = this.isNetworkErrorCode(code);
		this.isNetworkError.set(screen, isNetworkError);

		// External kill (code null) or missing URL should not be retried to prevent infinite loops
		const isMissingUrl = !url || url.trim() === '';
		const isExternalKill = code === null;

		// Handle network errors with valid URLs that are not external kills
		if (isNetworkError && url && !isMissingUrl && !isExternalKill && options) {
			const networkRetryCount = this.networkRetries.get(screen) || 0;
			const now = Date.now();
			const lastError = this.lastNetworkError.get(screen) || 0;
			const timeSinceLastError = now - lastError;

			// Reset network retry count if it's been a while since the last error
			if (timeSinceLastError > 2 * 60 * 1000) { // Reduced from 5 minutes to 2 minutes
				logger.info(`Resetting network retry count for screen ${screen} as it's been ${Math.round(timeSinceLastError / 1000)}s since last error`, 'PlayerService');
				this.networkRetries.set(screen, 0);
			}

			// Update last error time
			this.lastNetworkError.set(screen, now);

			// Check if we should retry
			if (networkRetryCount < this.MAX_NETWORK_RETRIES) {
				// Calculate backoff time with exponential backoff
				const backoffTime = Math.min(this.NETWORK_RETRY_INTERVAL * Math.pow(1.5, networkRetryCount), this.MAX_BACKOFF_TIME);

				logger.info(`Network error detected for ${url} on screen ${screen}, retry ${networkRetryCount + 1}/${this.MAX_NETWORK_RETRIES} in ${Math.round(backoffTime / 1000)}s`, 'PlayerService');

				// Increment retry count
				this.networkRetries.set(screen, networkRetryCount + 1);

				// Clean up but don't emit error yet
				this.cleanup_after_stop(screen);
				this.clearMonitoring(screen);

				// Set up retry timer
				const retryTimer = setTimeout(async () => {
					try {
						logger.info(`Attempting to restart stream ${url} on screen ${screen} after network error`, 'PlayerService');
						await this.startStream({
							...options,
							isRetry: true
						});
					} catch (error) {
						logger.error(`Failed to restart stream after network error on screen ${screen}`, 'PlayerService',
							error instanceof Error ? error : new Error(String(error)));

						// Now emit the error since retry failed
						this.errorCallback?.({
							screen,
							error: `Failed to restart stream after network error: ${error instanceof Error ? error.message : String(error)}`,
							code: code || 0,
							url,
							moveToNext: true
						});
					}
				}, backoffTime);

				// Store the timer
				this.retryTimers.set(screen, retryTimer);
				return; // Don't emit error yet, we're handling it with retry
			} else {
				logger.warn(`Maximum network retries (${this.MAX_NETWORK_RETRIES}) reached for screen ${screen}, giving up`, 'PlayerService');
				// Reset retry count for future attempts
				this.networkRetries.set(screen, 0);
			}
		} else if (isExternalKill) {
			logger.warn(`Process on screen ${screen} was killed externally (code: ${code}), skipping retry`, 'PlayerService');
		} else if (isMissingUrl) {
			logger.warn(`Process on screen ${screen} has no URL, skipping retry to prevent infinite loop`, 'PlayerService');
		}

		// For non-network errors or if max retries reached, clean up and emit error
		this.cleanup_after_stop(screen);
		this.clearMonitoring(screen);

		// Calculate whether to move to next or restart
		const normalExit = code === 0;
		const missingUrl = !url || url.trim() === '';
		const externalKill = code === null;
		const moveToNext = normalExit || missingUrl || externalKill; 
		const shouldRestart = !normalExit && !missingUrl && !externalKill && !this.isShuttingDown;

		// Emit stream error with URL if we have it
		this.errorCallback?.({
			screen,
			error: normalExit ? 'Stream ended normally' : `Stream ended with code ${code}`,
			code: code || 0,
			url,
			moveToNext,
			shouldRestart
		});
	}

	private clearMonitoring(screen: number): void {
		logger.debug(`Clearing monitoring for screen ${screen}`, 'PlayerService');

		// Clear heartbeat monitoring
		this.clearHeartbeat(screen);

		// Clear health check
		const healthCheck = this.healthCheckIntervals.get(screen);
		if (healthCheck) {
			logger.debug(`Clearing health check interval for screen ${screen}`, 'PlayerService');
			clearInterval(healthCheck);
			this.healthCheckIntervals.delete(screen);
		} else {
			logger.debug(`No health check interval found for screen ${screen}`, 'PlayerService');
		}

		// Clear inactive timer
		const inactiveTimer = this.inactiveTimers.get(screen);
		if (inactiveTimer) {
			logger.debug(`Clearing inactive timer for screen ${screen}`, 'PlayerService');
			clearTimeout(inactiveTimer);
			this.inactiveTimers.delete(screen);
		} else {
			logger.debug(`No inactive timer found for screen ${screen}`, 'PlayerService');
		}

		// Clear retry timer if exists
		const retryTimer = this.retryTimers.get(screen);
		if (retryTimer) {
			logger.debug(`Clearing retry timer for screen ${screen}`, 'PlayerService');
			clearTimeout(retryTimer);
			this.retryTimers.delete(screen);
		} else {
			logger.debug(`No retry timer found for screen ${screen}`, 'PlayerService');
		}

		// Clear other state
		logger.debug(`Clearing other state maps for screen ${screen}`, 'PlayerService');
		this.streamStartTimes.delete(screen);
		this.streamRetries.delete(screen);
		// Don't clear networkRetries or lastNetworkError here to maintain retry history

		logger.debug(`Monitoring cleared for screen ${screen}`, 'PlayerService');
	}

	/**
	 * Determines if an exit code is likely related to network issues
	 */
	private isNetworkErrorCode(code: number | null): boolean {
		// Common network-related exit codes
		// 2: Streamlink network error
		// 1: General error (could be network)
		// 9: Killed (could happen during network fluctuations)
		return code === 2 || code === 1 || code === 9;
	}

	/**
	 * Stop a stream that is currently playing on a screen
	 */
	async stopStream(screen: number, force: boolean = false, isManualStop: boolean = false): Promise<boolean> {
		// Check if screen is already disabled
		if (this.disabledScreens.has(screen)) {
			logger.debug(`Screen ${screen} is disabled, no stream to stop`, 'PlayerService');
			return true;
		}

		// Log with URL information for better tracking
		const streamInstance = this.streams.get(screen);
		const url = streamInstance?.url || '';
		
		// Check if stream is already in stopping state to prevent race conditions
		if (streamInstance?.status === 'stopping') {
			logger.debug(`Stream on screen ${screen} already in stopping state, skipping duplicate stop request`, 'PlayerService');
			return true;
		}
		
		logger.info(`Stopping stream on screen ${screen}${url ? ` (${url})` : ''}, manual=${isManualStop}, force=${force}`, 'PlayerService');

		// Remove from manually closed screens
		if (isManualStop) {
			this.manuallyClosedScreens.add(screen);
		} else {
			this.manuallyClosedScreens.delete(screen);
		}

		// Clear network error status
		this.isNetworkError.delete(screen);

		// Get the stream object
		const player = this.streams.get(screen);

		// If there's no stream, consider it already stopped
		if (!player) {
			logger.debug(`No stream found for screen ${screen}`, 'PlayerService');
			this.cleanup_after_stop(screen);
			return true;
		}

		// Mark the stream as stopping to prevent race conditions
		player.status = 'stopping';

		// Check if process exists
		if (!player.process) {
			logger.debug(`No process found for stream on screen ${screen}`, 'PlayerService');
			this.cleanup_after_stop(screen);
			return true;
		}

		// If process is already gone, clean up
		if (!this.isProcessRunning(player.process.pid)) {
			logger.debug(`Process for screen ${screen} is already gone`, 'PlayerService');
			this.cleanup_after_stop(screen);
			return true;
		}

		// Log action
		logger.info(`Stopping stream on screen ${screen} (${isManualStop ? 'manual' : 'automatic'})`, 'PlayerService');

		try {
			// Use more aggressive kill if force is true
			const signal = force ? 'SIGKILL' : 'SIGTERM';

			// Try to gracefully stop the process
			player.process.kill(signal);

			// Wait a shorter time for process to exit gracefully
			await new Promise<void>((resolve) => {
				const timeout = setTimeout(() => {
					logger.warn(`Stream stop timeout on screen ${screen}, forcing kill`, 'PlayerService');
					try {
						if (player.process && this.isProcessRunning(player.process.pid)) {
							player.process.kill('SIGKILL');
						}
					} catch (error) {
						logger.error(`Error killing process on screen ${screen}`, 'PlayerService',
							error instanceof Error ? error : new Error(String(error)));
					}
					resolve();
				}, 250); // Reduced from 500ms to 250ms for faster transitions

				// If process exits gracefully, clear timeout and resolve
				player.process.once('exit', () => {
					clearTimeout(timeout);
					resolve();
				});
			});

			// Clean up regardless of kill success
			this.cleanup_after_stop(screen);

			return true;
		} catch (error) {
			this.logError(`Error stopping stream on screen ${screen}`, 'PlayerService', error);
			return false;
		}
	}

	/**
	 * Kill child processes of a given parent process
	 * Only kills processes that are directly related to our managed streams
	 */
	private killChildProcesses(parentPid?: number): void {
		if (!parentPid) {
			logger.debug('No parent PID provided to kill child processes', 'PlayerService');
			return;
		}

		try {
			// First try to kill the parent process
			try {
				process.kill(parentPid, 'SIGTERM');
				logger.debug(`Sent SIGTERM to parent process ${parentPid}`, 'PlayerService');
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
					logger.warn(`Error sending SIGTERM to parent process ${parentPid}`, 'PlayerService');
				}
			}

			// Give parent process time to clean up
			setTimeout(() => {
				try {
					// Check if parent is still running
					try {
						process.kill(parentPid, 0);
						// If we get here, process is still running, try SIGKILL
						process.kill(parentPid, 'SIGKILL');
						logger.debug(`Sent SIGKILL to parent process ${parentPid}`, 'PlayerService');
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
							logger.warn(`Error checking/killing parent process ${parentPid}`, 'PlayerService');
						}
					}

					// Try to get only the immediate child processes of the managed parent
					try {
						const childPidsStr = execSync(`pgrep -P ${parentPid}`, { encoding: 'utf8' }).trim();
						if (childPidsStr) {
							const childPids = childPidsStr.split('\n').map(Number);
							for (const pid of childPids) {
								try {
									// Check if this child process is part of our managed streams
									// before killing it
									const processInfo = execSync(`ps -p ${pid} -o comm=`, { encoding: 'utf8' }).trim();
									if (processInfo.includes('mpv') || processInfo.includes('streamlink')) {
										process.kill(pid, 'SIGTERM');
										logger.debug(`Sent SIGTERM to child process ${pid} (${processInfo})`, 'PlayerService');
									} else {
										logger.debug(`Skipping unrelated child process ${pid} (${processInfo})`, 'PlayerService');
									}
								} catch (error) {
									if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
										logger.warn(`Error handling child process ${pid}`, 'PlayerService');
									}
								}
							}
						}
					} catch (error) {
						// Ignore pgrep errors as the parent process might already be gone
						if (!(error as NodeJS.ErrnoException).message?.includes('Command failed: pgrep')) {
							const errorMsg = error instanceof Error ? error.message : String(error);
							logger.warn(`Error killing child processes: ${errorMsg}`, 'PlayerService');
						}
					}
				} catch (error) {
					const errorMsg = error instanceof Error ? error.message : String(error);
					logger.error(`Error in killChildProcesses: ${errorMsg}`, 'PlayerService');
				}
			}, 500); // Wait 500ms before checking/killing remaining processes
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			logger.error(`Error in killChildProcesses: ${errorMsg}`, 'PlayerService');
		}
	}

	/**
	 * Clean up resources after a stream is stopped
	 */
	cleanup_after_stop(screen: number): void {
		try {
			// Check if stream exists and isn't already being cleaned up
			const streamInstance = this.streams.get(screen);
			if (!streamInstance) {
				logger.debug(`No stream to clean up for screen ${screen}, already cleaned up`, 'PlayerService');
				return;
			}
			
			// Set a flag indicating this stream is being cleaned up
			streamInstance.status = 'stopping';
			
			logger.info(`Cleaning up resources for screen ${screen}`, 'PlayerService');

			// First, clear all monitoring timers
			logger.debug(`Clearing monitoring timers for screen ${screen}`, 'PlayerService');
			this.clearMonitoring(screen);

			// Get stream instance before deleting it
			const stream = this.streams.get(screen);

			// Log stream details for debugging
			if (stream) {
				logger.debug(`Cleaning up stream: screen=${stream.screen}, url=${stream.url}, pid=${stream.process?.pid || 'none'}, platform=${stream.platform}`, 'PlayerService');

				// Log stream process details if available
				if (stream.process?.pid) {
					logger.debug(`Stream process info: pid=${stream.process.pid}, killed=${stream.process.killed}, exitCode=${stream.process.exitCode}`, 'PlayerService');
				}
			} else {
				logger.debug(`No stream found for screen ${screen} during cleanup`, 'PlayerService');
			}

			// Delete from streams map immediately to prevent double processing
			logger.debug(`Removing stream from tracking map for screen ${screen}`, 'PlayerService');
			this.streams.delete(screen);

			// Clear all retry related maps
			logger.debug(`Clearing retry maps for screen ${screen}`, 'PlayerService');
			this.streamRetries.delete(screen);
			this.networkRetries.delete(screen);
			this.lastNetworkError.delete(screen);
			this.isNetworkError.delete(screen);
			this.streamStartTimes.delete(screen);
			this.startupLocks.delete(screen);

			// Clean up IPC socket if it exists
			const ipcPath = this.ipcPaths.get(screen);
			if (ipcPath) {
				logger.debug(`Checking IPC socket ${ipcPath} for screen ${screen}`, 'PlayerService');
				if (fs.existsSync(ipcPath)) {
					try {
						logger.debug(`Closing socket connection for screen ${screen}`, 'PlayerService');
						// Close any existing socket connection
						const socket = net.createConnection(ipcPath);
						socket.end();
						socket.destroy();

						// Remove the socket file
						if (fs.existsSync(ipcPath)) {
							logger.debug(`Removing IPC socket file ${ipcPath} for screen ${screen}`, 'PlayerService');
							fs.unlinkSync(ipcPath);
							logger.debug(`Successfully removed IPC socket for screen ${screen}`, 'PlayerService');
						}
					} catch (error) {
						// Only log as warning if file still exists
						if (fs.existsSync(ipcPath)) {
							const errorMsg = error instanceof Error ? error.message : String(error);
							logger.warn(`Failed to remove IPC socket for screen ${screen}: ${errorMsg}`, 'PlayerService');
						}
					}
				} else {
					logger.debug(`IPC socket ${ipcPath} does not exist for screen ${screen}`, 'PlayerService');
				}
			} else {
				logger.debug(`No IPC path found for screen ${screen}`, 'PlayerService');
			}
			logger.debug(`Removing IPC path mapping for screen ${screen}`, 'PlayerService');
			this.ipcPaths.delete(screen);

			// Kill any remaining processes
			if (stream?.process?.pid) {
				logger.debug(`Killing child processes for parent PID ${stream.process.pid} for screen ${screen}`, 'PlayerService');
				try {
					this.killChildProcesses(stream.process.pid);
					logger.debug(`Successfully requested kill for child processes of PID ${stream.process.pid}`, 'PlayerService');
				} catch (error) {
					logger.warn(`Error killing processes for screen ${screen}: ${error}`, 'PlayerService');
				}
			} else {
				logger.debug(`No process PID found for screen ${screen}, nothing to kill`, 'PlayerService');
			}

			// Verify cleanup completed successfully
			if (this.streams.has(screen)) {
				logger.warn(`Stream for screen ${screen} still exists after cleanup - forcing removal`, 'PlayerService');
				this.streams.delete(screen);
			}

			// Log the number of active streams after cleanup
			const remainingStreams = Array.from(this.streams.values()).filter(s => s.process && this.isProcessRunning(s.process.pid));
			const streamInfo = remainingStreams.map(s => `screen:${s.screen}, pid:${s.process?.pid}`).join('; ');

			logger.info(`Cleanup complete for screen ${screen}. Remaining active streams: ${remainingStreams.length}/${this.config.player.maxStreams} - ${streamInfo}`, 'PlayerService');
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			logger.error(`Error during cleanup for screen ${screen}: ${errorMsg}`, 'PlayerService');

			// Ensure stream is deleted even if there was an error
			logger.debug(`Forcing stream deletion for screen ${screen} after cleanup error`, 'PlayerService');
			this.streams.delete(screen);
		}
	}

	/**
	 * Check if a process is still running without sending a signal
	 */
	private isProcessRunning(pid: number | undefined): boolean {
		if (!pid) return false;

		try {
			// The kill with signal 0 doesn't actually kill the process
			// It just checks if the process exists
			process.kill(pid, 0);

			// Additional check - verify socket file exists for MPV processes
			const stream = Array.from(this.streams.values()).find(s => s.process && s.process.pid === pid);
			if (stream) {
				const ipcPath = this.ipcPaths.get(stream.screen);
				if (ipcPath && !fs.existsSync(ipcPath)) {
					logger.warn(`Process ${pid} is running but IPC socket ${ipcPath} doesn't exist`, 'PlayerService');
					return false;
				}
			}

			return true;
		} catch {
			return false;
		}
	}

	private getTitle(options: StreamOptions & { screen: number }): string {
		// Simplify the escaping - just replace double quotes with single quotes
		const title = `Screen ${options.screen}: ${options.url} - ${options.title} - Viewers: ${options.viewerCount} - start time: ${options.startTime}`
			.replace(/"/g, "'");

		return title; // No need to add extra quotes - those will be added by the argument handling
	}
	private getMpvArgs(options: StreamOptions & { screen: number }, includeUrl: boolean = true): string[] {
		const screenConfig = this.config.player.screens.find(s => s.screen === options.screen);
		if (!screenConfig) {
			throw new Error(`No screen configuration found for screen ${options.screen}`);
		}

		// Initialize IPC path if not already set
		if (!this.ipcPaths.has(options.screen)) {
			const ipcPath = `/tmp/mpv-socket-${options.screen}`;
			this.ipcPaths.set(options.screen, ipcPath);
		}

		// Ensure log directory exists
		if (!fs.existsSync(this.BASE_LOG_DIR)) {
			fs.mkdirSync(this.BASE_LOG_DIR, { recursive: true });
		}

		const logFile = path.join(this.BASE_LOG_DIR, `screen_${options.screen}.log`);
		const ipcPath = this.ipcPaths.get(options.screen);

		if (!ipcPath) {
			throw new Error(`No IPC path found for screen ${options.screen}`);
		}

		const baseArgs: string[] = [];

		// Add global MPV arguments from config
		if (this.config.mpv) {
			for (const [key, value] of Object.entries(this.config.mpv)) {
				if (value !== undefined && value !== null) {
					baseArgs.push(`--${key}=${value}`);
				}
			}
		}

		// Add screen-specific MPV arguments from streamlink config
		if (this.config.streamlink?.mpv) {
			for (const [key, value] of Object.entries(this.config.streamlink.mpv)) {
				if (value !== undefined && value !== null) {
					baseArgs.push(`--${key}=${value}`);
				}
			}
		}

		// Essential arguments
		baseArgs.push(
			`--input-ipc-server=${ipcPath}`,
			`--config-dir=${path.join(process.cwd(), 'scripts', 'mpv')}`,
			`--log-file=${logFile}`,
			`--geometry=${screenConfig.width}x${screenConfig.height}+${screenConfig.x}+${screenConfig.y}`,
			`--volume=${(options.volume || 0).toString()}`,
			`--title="${this.getTitle(options)}"`,
			'--msg-level=all=debug'
		);

		if (options.windowMaximized) {
			baseArgs.push('--window-maximized=yes');
		}

		// Add URL if requested
		if (includeUrl && options.url) {
			baseArgs.push(options.url);
		}

		logger.info(`MPV args for screen ${options.screen}: ${baseArgs.join(' ')}`, 'PlayerService');
		return baseArgs;
	}
	private getStreamlinkArgs(url: string, options: StreamOptions & { screen: number }): string[] {
		const screenConfig = this.config.player.screens.find(s => s.screen === options.screen);
		if (!screenConfig) {
			throw new Error(`No screen config found for screen ${options.screen}`);
		}

		// Start with streamlink-specific arguments
		const streamlinkArgs = [
			url,
			options.quality || screenConfig.quality || this.config.player.defaultQuality || 'best',
			'--player',
			this.mpvPath
		];

		// Add streamlink options from config
		if (this.config.streamlink?.options) {
			Object.entries(this.config.streamlink.options).forEach(([key, value]) => {
				if (value === true) {
					streamlinkArgs.push(`--${key}`);
				} else if (value !== false && value !== undefined && value !== null) {
					streamlinkArgs.push(`--${key}`, String(value));
				}
			});
		}

		// Add HTTP headers if configured
		if (this.config.streamlink?.http_header) {
			Object.entries(this.config.streamlink.http_header).forEach(([key, value]) => {
				streamlinkArgs.push('--http-header', `${key}=${value}`);
			});
		}

		// Get MPV arguments without the URL (we don't want streamlink to pass the URL to MPV)
		const mpvArgs = this.getMpvArgs(options, false);

		// FIXED: Don't join MPV args into a single quoted string
		// Instead, add --player-args and then each argument properly
		streamlinkArgs.push('--player-args');

		// Join all MPV args into a properly escaped single string
		// This is the critical fix - we need one properly escaped string
		const mpvArgsString = mpvArgs
			.map(arg => {
				// Handle special characters in arguments
				return arg.replace(/"/g, '\\"');
			})
			.join(' ');

		// Add the entire MPV command as a single quoted argument
		streamlinkArgs.push(mpvArgsString);

		// Add any additional streamlink arguments from config
		if (this.config.streamlink?.args) {
			streamlinkArgs.push(...this.config.streamlink.args);
		}

		logger.debug(`Streamlink args: ${streamlinkArgs.join(' ')}`, 'PlayerService');
		return streamlinkArgs;
	}

	private getProcessEnv(): NodeJS.ProcessEnv {
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

		return {
			...process.env,
			MPV_HOME: undefined,
			XDG_CONFIG_HOME: undefined,
			DISPLAY: process.env.DISPLAY || ':0',
			SDL_VIDEODRIVER: 'x11',
			DATE: timestamp
		};
	}

	public getActiveStreams() {
		return Array.from(this.streams.entries()).map(([screen, stream]) => ({
			screen,
			url: stream.url,
			quality: stream.quality,
			platform: stream.platform,
			status: stream.status
		}));
	}

	public sendCommandToScreen(screen: number, command: string): void {
		const ipcPath = this.ipcPaths.get(screen);
		if (!ipcPath) {
			logger.warn(`No IPC path found for screen ${screen}`, 'PlayerService');
			return;
		}

		try {
			exec(`echo "${command}" | socat - ${ipcPath}`, (err) => {
				if (err) {
					this.logError(`Failed to send command to screen ${screen}`, 'PlayerService', err);
				}
			});
		} catch (err) {
			this.logError(`Command send error for screen ${screen}`, 'PlayerService', err);
		}
	}

	public sendCommandToAll(command: string): void {
		this.ipcPaths.forEach((_, screen) => {
			this.sendCommandToScreen(screen, command);
		});
	}

	public onStreamOutput(callback: (data: StreamOutput) => void): void {
		this.outputCallback = callback;
	}

	public onStreamError(callback: (data: StreamError) => void): void {
		this.errorCallback = (data: StreamError) => {
			// Log all stream errors with URL information for better tracking
			if (data.url) {
				logger.info(`Stream error on screen ${data.screen} with url ${data.url}: ${data.error} (code: ${data.code})`, 'PlayerService');
			} else {
				logger.warn(`Stream error on screen ${data.screen} without URL: ${data.error} (code: ${data.code})`, 'PlayerService');

				// Try to get URL from streams map if missing
				const stream = this.streams.get(data.screen);
				if (stream?.url) {
					data.url = stream.url;
					logger.info(`Added missing URL ${stream.url} to stream error for screen ${data.screen}`, 'PlayerService');
				} else {
					// If still no URL, make sure we move to next stream to avoid infinite loops
					logger.warn(`Cannot recover URL for screen ${data.screen}, ensuring moveToNext=true to prevent loops`, 'PlayerService');
					data.moveToNext = true;
					data.shouldRestart = false;
				}
			}
			callback(data);
		};
	}

	public onStreamEnd(callback: (data: StreamEnd) => void): void {
		this.endCallback = callback;
	}

	public handleLuaMessage(screen: number, type: string, data: Record<string, unknown>): void {
		if (type === 'log' && typeof data.level === 'string' && typeof data.message === 'string') {
			logger[data.level as 'debug' | 'info' | 'warn' | 'error'](
				`[MPV-${screen}] ${data.message}`,
				'PlayerService'
			);
		} else {
			logger.debug(
				`Received message from screen ${screen}: ${type} - ${JSON.stringify(data)}`,
				'PlayerService'
			);
		}
	}

	public async cleanup(): Promise<void> {
		if (this.isShuttingDown) return;

		this.isShuttingDown = true;
		logger.info('Cleaning up player service...', 'PlayerService');

		try {
			// Stop all streams with force=true to ensure they're killed
			const activeScreens = Array.from(this.streams.keys());

			// Attempt graceful shutdown first
			const promises = activeScreens.map((screen) => this.stopStream(screen, false));
			await Promise.allSettled(promises);

			// Wait a moment for graceful shutdown to complete
			await new Promise(resolve => setTimeout(resolve, 500));

			// Force kill any remaining streams
			const remainingScreens = Array.from(this.streams.keys());
			if (remainingScreens.length > 0) {
				logger.warn(`Forcing shutdown of ${remainingScreens.length} remaining streams`, 'PlayerService');
				const forcePromises = remainingScreens.map((screen) => this.stopStream(screen, true));
				await Promise.allSettled(forcePromises);
			}

			// Clear all timers and state
			activeScreens.forEach((screen) => {
				this.clearMonitoring(screen);
			});

			// Clear all heartbeat intervals
			for (const [screen, interval] of this.heartbeatIntervals.entries()) {
				clearInterval(interval);
				logger.debug(`Cleared heartbeat interval for screen ${screen} during cleanup`, 'PlayerService');
			}
			this.heartbeatIntervals.clear();
			this.heartbeatStatuses.clear();

			// Clean up IPC sockets
			this.ipcPaths.forEach((ipcPath) => {
				try {
					if (fs.existsSync(ipcPath)) {
						fs.unlinkSync(ipcPath);
					}
				} catch (error) {
					this.logError(`Failed to remove IPC socket ${ipcPath}`, 'PlayerService', error);
				}
			});

			// Reset all state
			this.ipcPaths.clear();
			this.streams.clear();
			this.manuallyClosedScreens.clear();
			this.disabledScreens.clear();
			this.streamRetries.clear();
			this.streamStartTimes.clear();

			logger.info('Player service cleanup complete', 'PlayerService');
		} catch (error) {
			logger.error(
				'Error during player service cleanup',
				'PlayerService',
				error instanceof Error ? error : new Error(String(error))
			);
			throw error;
		}
	}

	public isRetrying(screen: number): boolean {
		return this.streamRetries.has(screen);
	}

	public disableScreen(screen: number): void {
		logger.info(`Disabling screen ${screen} in player service`, 'PlayerService');
		this.disabledScreens.add(screen);

		// Also add to manually closed screens to prevent auto-restart attempts
		this.manuallyClosedScreens.add(screen);

		// Immediately clear all monitoring for this screen to reduce resource usage
		this.clearMonitoring(screen);

		// Try to directly kill any MPV process for this screen
		const streamInstance = this.streams.get(screen);
		if (streamInstance && streamInstance.process) {
			logger.info(`Force killing MPV process on screen ${screen}`, 'PlayerService');
			try {
				// Send SIGKILL for immediate termination
				streamInstance.process.kill('SIGKILL');
			} catch (error) {
				logger.warn(`Error killing MPV process on screen ${screen}`, 'PlayerService',
					error instanceof Error ? error.message : String(error));
			}

			// Make sure we clean up even if kill fails
			this.cleanup_after_stop(screen);
		} else {
			logger.info(`No active process found for screen ${screen} during disable`, 'PlayerService');
		}

		// Last resort: Use pkill to make sure the process is truly gone
		this.killProcessByScreenNumber(screen);
	}

	public enableScreen(screen: number): void {
		logger.info(`Enabling screen ${screen} in player service`, 'PlayerService');
		this.disabledScreens.delete(screen);

		// Remove from manually closed screens to allow streams to start
		this.manuallyClosedScreens.delete(screen);
	}

	// Helper method to extract title from URL
	private extractTitleFromUrl(url: string): string | null {
		try {
			// Extract video ID from YouTube URL
			if (url.includes('youtube.com') || url.includes('youtu.be')) {
				const urlObj = new URL(url);
				let videoId;

				if (url.includes('youtube.com/watch')) {
					videoId = urlObj.searchParams.get('v');
				} else if (url.includes('youtu.be/')) {
					videoId = url.split('youtu.be/')[1]?.split(/[/?#]/)[0];
				} else if (url.includes('youtube.com/live/')) {
					videoId = url.split('youtube.com/live/')[1]?.split(/[/?#]/)[0];
				} else if (url.includes('youtube.com/channel/')) {
					const channelId = url.split('youtube.com/channel/')[1]?.split(/[/?#]/)[0];
					return channelId ? `YouTube Channel (${channelId})` : 'YouTube Stream';
				}

				return videoId ? `YouTube Video (${videoId})` : 'YouTube Stream';
			}

			// Extract channel name from Twitch URL
			if (url.includes('twitch.tv')) {
				const channelName = url.split('twitch.tv/')[1]?.split(/[/?#]/)[0];
				return channelName ? `Twitch Stream (${channelName})` : 'Twitch Stream';
			}

			// For other URLs, use the hostname
			const hostname = new URL(url).hostname;
			return hostname ? `Stream from ${hostname}` : 'Unknown Stream';
		} catch (err) {
			this.logError('Failed to extract title from URL', 'PlayerService', err);
			return 'Unknown Stream';
		}
	}

	/**
	 * Sends a command directly to the MPV IPC socket
	 */
	private async sendMpvCommand(screen: number, command: string): Promise<void> {
		const ipcPath = this.ipcPaths.get(screen);
		logger.info(`Sending command ${command} to screen ${screen} with IPC path ${ipcPath}`, 'PlayerService');
		if (!ipcPath) {
			logger.warn(`No IPC path found for screen ${screen}`, 'PlayerService');
			throw new Error(`No IPC socket for screen ${screen}`);
		}

		return new Promise((resolve, reject) => {
			try {
				const socket = net.createConnection(ipcPath);
				let hasResponded = false;

				// Set a shorter connection timeout
				socket.setTimeout(500);

				socket.on('connect', () => {
					const mpvCommand = JSON.stringify({ command: [command] });
					socket.write(mpvCommand + '\n', () => {
						// Wait a brief moment after writing to ensure command is sent
						setTimeout(() => {
							if (!hasResponded) {
								hasResponded = true;
								socket.end();
								resolve();
							}
						}, 100);
					});
				});

				socket.on('error', (err: Error) => {
					if (!hasResponded) {
						hasResponded = true;
						socket.destroy();
						this.logError(`Failed to send command to screen ${screen}`, 'PlayerService', err);
						reject(err);
					}
				});

				socket.on('timeout', () => {
					if (!hasResponded) {
						hasResponded = true;
						socket.destroy();
						logger.error(`Command send timeout for screen ${screen}`, 'PlayerService');
						reject(new Error('Socket timeout'));
					}
				});

				// Cleanup socket on any response
				socket.on('data', () => {
					if (!hasResponded) {
						hasResponded = true;
						socket.end();
						resolve();
					}
				});

				// Handle socket close
				socket.on('close', () => {
					if (!hasResponded) {
						hasResponded = true;
						reject(new Error('Socket closed unexpectedly'));
					}
				});
			} catch (err) {
				this.logError(`Command send error for screen ${screen}`, 'PlayerService', err instanceof Error ? err : String(err));
				reject(err);
			}
		});
	}

	private logError(message: string, service: string, error: unknown): void {
		if (error instanceof Error) {
			logger.error(message, service, error);
		} else {
			logger.error(message, service, new Error(String(error)));
		}
	}

	/**
	 * Set up heartbeat monitoring for a stream to detect if it becomes unresponsive
	 */
	private setupHeartbeat(screen: number): void {
		// Clear any existing heartbeat interval
		this.clearHeartbeat(screen);

		logger.debug(`Setting up heartbeat monitoring for screen ${screen}`, 'PlayerService');

		// Create a new heartbeat interval
		const interval = setInterval(() => this.checkStreamHealth(screen), this.HEARTBEAT_INTERVAL);
		this.heartbeatIntervals.set(screen, interval);

		// Initialize status as alive
		this.heartbeatStatuses.set(screen, true);

		// Do an initial health check
		this.checkStreamHealth(screen);
	}

	/**
	 * Clear heartbeat monitoring for a screen
	 */
	private clearHeartbeat(screen: number): void {
		const interval = this.heartbeatIntervals.get(screen);
		if (interval) {
			clearInterval(interval);
			this.heartbeatIntervals.delete(screen);
			logger.debug(`Cleared heartbeat monitoring for screen ${screen}`, 'PlayerService');
		}

		this.heartbeatStatuses.delete(screen);
	}

	/**
	 * Check if a stream is still responsive by sending a simple command to the player
	 */
	private async checkStreamHealth(screen: number): Promise<void> {
		// Skip if stream is not active
		const stream = this.streams.get(screen);
		if (!stream || !stream.process || !this.isProcessRunning(stream.process.pid)) {
			return;
		}

		const ipcPath = this.ipcPaths.get(screen);
		if (!ipcPath || !fs.existsSync(ipcPath)) {
			// No IPC socket means we can't communicate - consider unresponsive
			logger.warn(`No IPC socket found for screen ${screen} during heartbeat check`, 'PlayerService');
			this.handleUnresponsiveStream(screen);
			return;
		}

		try {
			// Set a flag to track if we get a response
			let hasResponded = false;

			// Create a timeout to detect if the command doesn't respond
			const timeout = setTimeout(() => {
				if (!hasResponded) {
					logger.warn(`Heartbeat check timed out for screen ${screen}`, 'PlayerService');
					this.heartbeatStatuses.set(screen, false);
					this.handleUnresponsiveStream(screen);
				}
			}, this.HEARTBEAT_TIMEOUT);

			// Send a simple get_property command to check if player responds
			const socket = net.createConnection(ipcPath);
			socket.on('connect', () => {
				const command = JSON.stringify({ command: ['get_property', 'playback-time'] });
				socket.write(command + '\n');
			});

			socket.on('data', (data) => {
				// We got a response, stream is alive
				hasResponded = true;
				clearTimeout(timeout);

				// Only log if previous status was false (stream recovered)
				if (this.heartbeatStatuses.get(screen) === false) {
					logger.info(`Stream on screen ${screen} is responsive again`, 'PlayerService');
				}

				this.heartbeatStatuses.set(screen, true);
				socket.end();
			});

			socket.on('error', (err) => {
				// Socket connection error - stream likely unresponsive
				clearTimeout(timeout);
				if (!hasResponded) {
					logger.warn(`Heartbeat check socket error for screen ${screen}: ${err.message}`, 'PlayerService');
					this.heartbeatStatuses.set(screen, false);
					this.handleUnresponsiveStream(screen);
				}
				socket.destroy();
			});

			socket.on('timeout', () => {
				// Socket timeout - stream likely unresponsive
				clearTimeout(timeout);
				if (!hasResponded) {
					logger.warn(`Heartbeat check socket timeout for screen ${screen}`, 'PlayerService');
					this.heartbeatStatuses.set(screen, false);
					this.handleUnresponsiveStream(screen);
				}
				socket.destroy();
			});
		} catch (error) {
			logger.error(
				`Error during heartbeat check for screen ${screen}`,
				'PlayerService',
				error instanceof Error ? error : new Error(String(error))
			);

			// Consider stream unresponsive if we can't even connect
			this.heartbeatStatuses.set(screen, false);
			this.handleUnresponsiveStream(screen);
		}
	}

	/**
	 * Handle an unresponsive stream by attempting recovery
	 */
	private handleUnresponsiveStream(screen: number): void {
		// Check if the stream was previously marked unresponsive
		const wasUnresponsiveBefore = this.heartbeatStatuses.get(screen) === false;

		// Update status to unresponsive
		this.heartbeatStatuses.set(screen, false);

		// Skip if already handled (avoid duplicate recovery attempts)
		if (wasUnresponsiveBefore) {
			return;
		}

		logger.warn(`Stream on screen ${screen} appears to be unresponsive, attempting recovery`, 'PlayerService');

		// Get stream info for recovery
		const stream = this.streams.get(screen);
		if (!stream) {
			logger.error(`No stream data found for unresponsive screen ${screen}`, 'PlayerService');
			return;
		}

		// Emit error to trigger external recovery
		this.errorCallback?.({
			screen,
			error: 'Stream unresponsive (heartbeat failure)',
			code: 1000, // Custom code for heartbeat failure
			url: stream.url,
			moveToNext: true // Signal to move to next stream
		});
	}

	/**
	 * Last resort attempt to kill MPV for a specific screen using pkill
	 */
	private killProcessByScreenNumber(screen: number): void {
		try {
			logger.debug(`Trying to force kill MPV for screen ${screen} using pkill`, 'PlayerService');

			// Try to kill MPV instance for this specific screen 
			// using the mpv IPC identifier in command line arguments
			exec(`pkill -f "mpv.*mpv-ipc-${screen}$" || true`, (error) => {
				if (error) {
					// Just log error, don't throw - this is a best-effort cleanup
					logger.debug(`Pkill command failed for screen ${screen}: ${error.message}`, 'PlayerService');
				}
			});
		} catch (error) {
			// Just log the error, this is just a last-resort cleanup attempt
			logger.debug(`Failed to execute pkill for screen ${screen}: ${error instanceof Error ? error.message : String(error)}`, 'PlayerService');
		}
	}

	// Helper method to check if an executable exists
	private async checkExecutableExists(execPath: string): Promise<boolean> {
		return new Promise<boolean>(resolve => {
			exec(`which ${execPath}`, (error) => {
				if (error) {
					// Try with 'command -v' as a fallback
					exec(`command -v ${execPath}`, (err2) => {
						resolve(!err2);
					});
				} else {
					resolve(true);
				}
			});
		});
	}
}
