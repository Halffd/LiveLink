import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import type { Config, StreamlinkConfig, ScreenConfig } from '../../types/stream.js';
import type { StreamOutput, StreamError, StreamResponse, StreamEnd } from '../../types/stream_instance.js';
import { logger } from './logger.js';
import { exec, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import net from 'net';

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
	private readonly MAX_RETRIES = 3; // Increased from 2 to 3
	private readonly MAX_NETWORK_RETRIES = 5; // Separate counter for network-related issues
	private readonly RETRY_INTERVAL = 200; // Reduced from 500ms to 200ms
	private readonly NETWORK_RETRY_INTERVAL = 2000; // Reduced from 5s to 2s for network retries
	private readonly MAX_BACKOFF_TIME = 30000; // Reduced from 60s to 30s maximum backoff
	private readonly STREAM_REFRESH_INTERVAL = 2 * 60 * 60 * 1000; // Reduced from 4 hours to 2 hours
	private readonly INACTIVE_RESET_TIMEOUT = 2 * 60 * 1000; // Reduced from 5 minutes to 2 minutes
	private readonly STARTUP_TIMEOUT = 30000; // Reduced from 60s to 30s
	private readonly SHUTDOWN_TIMEOUT = 1000; // Reduced from 2s to 1s
	private readonly SCRIPTS_PATH: string;
	private streams: Map<number, LocalStreamInstance> = new Map();
	private streamRetries: Map<number, number> = new Map();
	private networkRetries: Map<number, number> = new Map(); // Track network-specific retries separately
	private lastNetworkError: Map<number, number> = new Map(); // Track when the last network error occurred
	private streamStartTimes: Map<number, number> = new Map();
	private streamRefreshTimers: Map<number, NodeJS.Timeout> = new Map();
	private inactiveTimers: Map<number, NodeJS.Timeout> = new Map();
	private healthCheckIntervals: Map<number, NodeJS.Timeout> = new Map();
	private startupLocks: Map<number, boolean> = new Map();
	private manuallyClosedScreens: Set<number> = new Set();
	private disabledScreens: Set<number> = new Set();
	private ipcPaths: Map<number, string> = new Map();
	private isNetworkError: Map<number, boolean> = new Map(); // Track if error is network-related

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
		} catch (err) {
			logger.error(
				'Failed to initialize directories',
				'PlayerService',
				err instanceof Error ? err : new Error(String(err))
			);
		}
	}

	private clearOldLogs(directory: string): void {
		try {
			if (!fs.existsSync(directory)) return;

			const files = fs.readdirSync(directory);
			const now = Date.now();
			const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days

			for (const file of files) {
				if (!file.endsWith('.log')) continue;

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
			// Check if screen is disabled
			if (this.disabledScreens.has(options.screen)) {
				logger.warn(`Attempted to start stream on disabled screen ${options.screen}`, 'PlayerService');
			return {
					screen: options.screen,
					success: false,
					error: 'Screen is disabled'
				};
			}

			// Check for maximum streams limit
			const activeStreams = Array.from(this.streams.values()).filter(s => s.process && this.isProcessRunning(s.process.pid));
			if (activeStreams.length >= this.config.player.maxStreams) {
				logger.warn(`Maximum number of streams (${this.config.player.maxStreams}) reached, active: ${activeStreams.length}`, 'PlayerService');
				return {
					screen: options.screen,
					success: false,
					error: `Maximum number of streams (${this.config.player.maxStreams}) reached`
				};
			}

			// Check if we're already starting a stream on this screen
			if (this.startupLocks.get(options.screen)) {
				logger.warn(`Stream startup already in progress for screen ${options.screen}`, 'PlayerService');
			return {
					screen: options.screen,
					success: false,
					error: 'Stream startup already in progress'
				};
			}

			// Set startup lock
			this.startupLocks.set(options.screen, true);

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

			let playerProcess: ChildProcess;
			if (this.config.player.preferStreamlink || options.url.includes('twitch.tv')) {
				logger.info(`Starting Streamlink for screen ${options.screen}`, 'PlayerService');
				playerProcess = await this.startStreamlinkProcess(options);
			} else {
				logger.info(`Starting MPV for screen ${options.screen}`, 'PlayerService');
				playerProcess = await this.startMpvProcess(options);
			}

			if (!playerProcess || !playerProcess.pid) {
				throw new Error('Failed to start player process');
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

			// Clear startup lock
			this.startupLocks.set(options.screen, false);

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
		} catch (error) {
			// Clear startup lock on error
			this.startupLocks.set(options.screen, false);
			
			// Clean up any partially initialized stream
			this.cleanup_after_stop(options.screen);
			
			logger.error(
				`Failed to start stream on screen ${options.screen}`,
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

		logger.debug(`Starting MPV with command: ${this.mpvPath} ${args.join(' ')}`, 'PlayerService');
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
		logger.debug(`Streamlink args: ${args.join(' ')}`, 'PlayerService');
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
			if (!hasEndedStream) {
				hasEndedStream = true;
				const stream = this.streams.get(screen);
				const url = stream?.url || '';
				
				logger.info(`Stream ended on screen ${screen}${url ? ` (${url})` : ''}`, 'PlayerService');
				
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
			}
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
			this.logError(`Process error on screen ${screen}`, 'PlayerService', err);
			handleStreamEnd(err.message);
		});

		process.on('exit', (code: number | null) => {
			// Get the URL before any cleanup happens
			const stream = this.streams.get(screen);
			const url = stream?.url || '';
			
			logger.info(`Process exited on screen ${screen} with code ${code}${url ? ` (${url})` : ''}`, 'PlayerService');
			
			// Only handle process exit if we haven't already handled stream end
			if (!hasEndedStream) {
				handleStreamEnd(`Process exited with code ${code || 0}`, code || 0);
			} else {
				cleanup();
			}
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

		// Setup refresh timer
		const refreshTimer = setTimeout(() => {
			logger.info(`Refreshing stream on screen ${screen}`, 'PlayerService');
			this.restartStream(screen, options).catch(error => {
				logger.error(`Failed to refresh stream on screen ${screen}`, 'PlayerService', error);
			});
		}, this.STREAM_REFRESH_INTERVAL);

		this.streamRefreshTimers.set(screen, refreshTimer);
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
		const url = stream?.url || '';
		const options = stream?.options;
		
		// Log with URL for better tracking
		logger.info(`Process exited on screen ${screen} with code ${code}${url ? ` (${url})` : ''}`, 'PlayerService');
		
		// Check if this is a network-related error
		const isNetworkError = this.isNetworkErrorCode(code);
		this.isNetworkError.set(screen, isNetworkError);
		
		// Handle retries for network errors differently
		if (isNetworkError && url && options) {
			const networkRetryCount = this.networkRetries.get(screen) || 0;
			const now = Date.now();
			const lastError = this.lastNetworkError.get(screen) || 0;
			const timeSinceLastError = now - lastError;
			
			// Reset network retry count if it's been a while since the last error
			if (timeSinceLastError > 2 * 60 * 1000) { // Reduced from 5 minutes to 2 minutes
				logger.info(`Resetting network retry count for screen ${screen} as it's been ${Math.round(timeSinceLastError/1000)}s since last error`, 'PlayerService');
				this.networkRetries.set(screen, 0);
			}
			
			// Update last error time
			this.lastNetworkError.set(screen, now);
			
			// Check if we should retry
			if (networkRetryCount < this.MAX_NETWORK_RETRIES) {
				// Calculate backoff time with exponential backoff
				const backoffTime = Math.min(this.NETWORK_RETRY_INTERVAL * Math.pow(1.5, networkRetryCount), this.MAX_BACKOFF_TIME);
				
				logger.info(`Network error detected for ${url} on screen ${screen}, retry ${networkRetryCount + 1}/${this.MAX_NETWORK_RETRIES} in ${Math.round(backoffTime/1000)}s`, 'PlayerService');
				
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
		}
		
		// For non-network errors or if max retries reached, clean up and emit error
		this.cleanup_after_stop(screen);
		this.clearMonitoring(screen);

		// Emit stream error with URL if we have it
		this.errorCallback?.({
			screen,
			error: code === 0 ? 'Stream ended normally' : `Stream ended with code ${code}`,
			code: code || 0,
			url,
			moveToNext: true // Always signal to move to next stream
		});
	}

	private clearMonitoring(screen: number): void {
		// Clear health check
		const healthCheck = this.healthCheckIntervals.get(screen);
		if (healthCheck) {
			clearInterval(healthCheck);
			this.healthCheckIntervals.delete(screen);
		}

		// Clear refresh timer
		const refreshTimer = this.streamRefreshTimers.get(screen);
		if (refreshTimer) {
			clearTimeout(refreshTimer);
			this.streamRefreshTimers.delete(screen);
		}

		// Clear inactive timer
		const inactiveTimer = this.inactiveTimers.get(screen);
		if (inactiveTimer) {
			clearTimeout(inactiveTimer);
			this.inactiveTimers.delete(screen);
		}
		
		// Clear retry timer if exists
		const retryTimer = this.retryTimers.get(screen);
		if (retryTimer) {
			clearTimeout(retryTimer);
			this.retryTimers.delete(screen);
		}

		// Clear other state
		this.streamStartTimes.delete(screen);
		this.streamRetries.delete(screen);
		// Don't clear networkRetries or lastNetworkError here to maintain retry history
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
			return true;
		}
		
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
			
			// Wait a moment for process to exit gracefully
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
				}, 500); // Reduced from SHUTDOWN_TIMEOUT to 500ms
				
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

					// Try to get child processes
					const childPidsStr = execSync(`pgrep -P ${parentPid}`, { encoding: 'utf8' }).trim();
					if (childPidsStr) {
						const childPids = childPidsStr.split('\n').map(Number);
						for (const pid of childPids) {
							try {
					process.kill(pid, 'SIGTERM');
								logger.debug(`Sent SIGTERM to child process ${pid}`, 'PlayerService');
							} catch (error) {
								if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
									logger.warn(`Error killing child process ${pid}`, 'PlayerService');
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
			}, 500); // Wait 500ms before checking/killing remaining processes
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			logger.error(`Error in killChildProcesses: ${errorMsg}`, 'PlayerService');
		}
	}
	
	/**
	 * Clean up resources after a stream is stopped
	 */
	private cleanup_after_stop(screen: number): void {
		try {
			// Clear monitoring and state
			this.clearMonitoring(screen);
			const stream = this.streams.get(screen);
		this.streams.delete(screen);
		
		// Clean up IPC socket if it exists
		const ipcPath = this.ipcPaths.get(screen);
		if (ipcPath && fs.existsSync(ipcPath)) {
			try {
				// Close any existing socket connection
				const socket = net.createConnection(ipcPath);
				socket.end();
				socket.destroy();
				
				// Remove the socket file
				if (fs.existsSync(ipcPath)) {
				fs.unlinkSync(ipcPath);
					logger.debug(`Removed IPC socket for screen ${screen}`, 'PlayerService');
				}
			} catch (error) {
					// Only log as warning if file still exists
					if (fs.existsSync(ipcPath)) {
						const errorMsg = error instanceof Error ? error.message : String(error);
						logger.warn(`Failed to remove IPC socket for screen ${screen}: ${errorMsg}`, 'PlayerService');
					}
			}
		}
		this.ipcPaths.delete(screen);
		
			// Kill any remaining processes
			if (stream?.process?.pid) {
				try {
					this.killChildProcesses(stream.process.pid);
				} catch (error) {
					logger.debug(`Error killing processes for screen ${screen}: ${error}`, 'PlayerService');
				}
			}

			// Log the number of active streams after cleanup
			const remainingStreams = Array.from(this.streams.values()).filter(s => s.process && this.isProcessRunning(s.process.pid));
			logger.debug(`Cleanup complete for screen ${screen}. Remaining active streams: ${remainingStreams.length}/${this.config.player.maxStreams}`, 'PlayerService');
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			logger.error(`Error during cleanup for screen ${screen}: ${errorMsg}`, 'PlayerService');
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
			`--title=${options.screen}: ${options.title || 'No Title'}`,	
			'--msg-level=all=debug'
		);

		if (options.windowMaximized) {
			baseArgs.push('--window-maximized=yes');
		}

		// Add URL if requested
		if (includeUrl && options.url) {
			baseArgs.push(options.url);
		}

		logger.debug(`MPV args for screen ${options.screen}: ${baseArgs.join(' ')}`, 'PlayerService');
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

		// Properly quote and escape the MPV arguments
		const quotedMpvArgs = mpvArgs
			.map(arg => {
				// If arg already contains quotes, leave it as is
				if (arg.includes('"')) return arg;
				// If arg contains spaces, quote it
				if (arg.includes(' ')) return `"${arg}"`;
				return arg;
			})
			.join(' ');

		// Add player arguments
		streamlinkArgs.push('--player-args', quotedMpvArgs);

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
			
			// Kill any remaining streamlink processes
			try {
				logger.info('Checking for any remaining streamlink processes...', 'PlayerService');
				execSync('pkill -9 streamlink || true');
			} catch {
				// Ignore errors, this is just a precaution
			}
			
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
			// Even if there's an error, try to kill remaining processes
			try {
				execSync('pkill -9 streamlink || true');
				execSync('pkill -9 mpv || true');
			} catch {
				// Ignore errors
			}
			throw error;
		}
	}

	public isRetrying(screen: number): boolean {
		return this.streamRetries.has(screen);
	}

	public disableScreen(screen: number): void {
		this.disabledScreens.add(screen);
	}

	public enableScreen(screen: number): void {
		this.disabledScreens.delete(screen);
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
}
