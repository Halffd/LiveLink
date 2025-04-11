import { EventEmitter } from 'events';
import type { Config, StreamOptions } from '../../types/stream.js';
import type { StreamOutput, StreamError, StreamResponse } from '../../types/stream_instance.js';
import { logger } from './logger/index.js';
import path from 'path';
import fs from 'fs';
import net from 'net';
import { spawn, exec, execSync, type ChildProcess } from 'child_process';

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

type LogError = Error | string | number;

interface LocalStreamEnd {
	screen: number;
	error?: Error | string;
	code?: number;
}

export class PlayerService {
	private readonly BASE_LOG_DIR: string;
	private readonly MAX_RETRIES = 2;
	private readonly RETRY_INTERVAL = 500;
	private readonly STREAM_REFRESH_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours
	private readonly INACTIVE_RESET_TIMEOUT = 5 * 60 * 1000; // 5 minutes
	private readonly STARTUP_TIMEOUT = 30000; // 30 seconds for startup
	private readonly SHUTDOWN_TIMEOUT = 2000; // 2 seconds for shutdown
	private readonly SCRIPTS_PATH: string;
	private streams: Map<number, LocalStreamInstance> = new Map();
	private streamRetries: Map<number, number> = new Map();
	private streamStartTimes: Map<number, number> = new Map();
	private streamRefreshTimers: Map<number, NodeJS.Timeout> = new Map();
	private inactiveTimers: Map<number, NodeJS.Timeout> = new Map();
	private healthCheckIntervals: Map<number, NodeJS.Timeout> = new Map();
	private startupLocks: Map<number, boolean> = new Map();
	private manuallyClosedScreens: Set<number> = new Set();
	private disabledScreens: Set<number> = new Set();
	private ipcPaths: Map<number, string> = new Map();
	private retryTimers: Map<number, NodeJS.Timeout> = new Map();

	private readonly config: Config;
	private readonly mpvPath: string;
	private isShuttingDown = false;
	private events = new EventEmitter();
	private outputCallback?: (data: StreamOutput) => void;
	private errorCallback?: (data: StreamError) => void;
	private endCallback?: (data: LocalStreamEnd) => void;

	constructor(config: Config) {
		this.config = config;
		this.BASE_LOG_DIR = path.join(process.cwd(), 'logs');
		this.SCRIPTS_PATH = path.join(process.cwd(), 'scripts/mpv');
		this.mpvPath = this.findMpvPath();

		// Initialize directories
		this.initializeDirectories();
		this.registerSignalHandlers();

		// Start health checks
		this.startHealthChecks();
	}

	private startHealthChecks(): void {
		// Check every 30 seconds
		setInterval(() => {
			if (this.isShuttingDown) return;

			for (const [screen, stream] of this.streams.entries()) {
				if (!stream.process || !stream.process.pid) continue;

				try {
					process.kill(stream.process.pid, 0); // Test if process exists
				} catch {
					// Process is dead but not cleaned up
					logger.warn(`Found dead process for screen ${screen}, cleaning up`, 'PlayerService');
					this.handleProcessExit(screen, -1);
				}
			}
		}, 30000);
	}

	private findMpvPath(): string {
		try {
			return execSync('which mpv').toString().trim();
		} catch {
			logger.warn('MPV not found in PATH, using default "mpv"', 'PlayerService');
			return 'mpv';
		}
	}

	private async initializeDirectories(): Promise<void> {
		try {
			// Create log directories
			const logDirs = ['mpv', 'streamlink'].map(dir => path.join(this.BASE_LOG_DIR, dir));
			for (const dir of logDirs) {
				if (!fs.existsSync(dir)) {
					fs.mkdirSync(dir, { recursive: true });
				}
			}

			// Create .livelink directory in home
			const homedir = process.env.HOME || process.env.USERPROFILE;
			if (homedir) {
				const livelinkDir = path.join(homedir, '.livelink');
				if (!fs.existsSync(livelinkDir)) {
					fs.mkdirSync(livelinkDir, { recursive: true });
				}
			}

			// Clean old logs
			await this.cleanOldLogs();
		} catch (error) {
			logger.error('Failed to initialize directories', 'PlayerService', error instanceof Error ? error : new Error(String(error)));
			throw error;
		}
	}

	private async cleanOldLogs(): Promise<void> {
		const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
		const now = Date.now();

		for (const dir of ['mpv', 'streamlink']) {
			const logDir = path.join(this.BASE_LOG_DIR, dir);
			if (!fs.existsSync(logDir)) continue;

			try {
				const files = fs.readdirSync(logDir);
				for (const file of files) {
					if (!file.endsWith('.log')) continue;

					const filePath = path.join(logDir, file);
					const stats = fs.statSync(filePath);
					if (now - stats.mtime.getTime() > maxAge) {
						fs.unlinkSync(filePath);
						logger.debug(`Deleted old log file: ${filePath}`, 'PlayerService');
					}
				}
			} catch (error) {
				logger.error(`Failed to clean logs in ${dir}`, 'PlayerService', error instanceof Error ? error : new Error(String(error)));
			}
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
		const { screen } = options;

		// Check maximum streams limit
		const activeStreams = Array.from(this.streams.values()).filter((s) => s.process !== null);
		if (activeStreams.length >= this.config.player.maxStreams) {
			return {
				screen,
				message: `Maximum number of streams (${this.config.player.maxStreams}) reached`,
				error: `Maximum number of streams (${this.config.player.maxStreams}) reached`,
				success: false
			};
		}

		// Check startup lock
		if (this.startupLocks.get(screen)) {
			return {
				screen,
				message: `Stream startup in progress for screen ${screen}`,
				success: false
			};
		}

		// Set startup lock with timeout
		this.startupLocks.set(screen, true);
		const lockTimeout = setTimeout(() => {
			this.startupLocks.set(screen, false);
		}, this.STARTUP_TIMEOUT);

		try {
			// Stop existing stream if any
			await this.stopStream(screen);

			// Get screen configuration
			const screenConfig = this.config.player.screens.find((s) => s.screen === screen);
			if (!screenConfig) {
				throw new Error(`Invalid screen number: ${screen}`);
			}

			// Check if screen is disabled
			if (this.disabledScreens.has(screen)) {
				throw new Error(`Screen ${screen} is disabled`);
			}

			// Don't start during shutdown
			if (this.isShuttingDown) {
				throw new Error('Server is shutting down');
			}

			// Clear manually closed flag - we're explicitly starting a new stream
			this.manuallyClosedScreens.delete(screen);

			// Determine player type
			const useStreamlink =
				screenConfig.playerType === 'streamlink' ||
				(!screenConfig.playerType && this.config.player.preferStreamlink);

			// Ensure we have metadata for the title
			const streamTitle =
				options.title || this.extractTitleFromUrl(options.url) || 'Unknown Stream';

			// Get current date/time for the title
			const currentTime = new Date().toLocaleTimeString();

			// Add metadata to options for use in player commands
			options.title = streamTitle;
			options.viewerCount = options.viewerCount || 0;
			options.startTime = options.startTime || currentTime;

			logger.info(
				`Starting stream with title: ${streamTitle}, viewers: ${options.viewerCount}, time: ${options.startTime}, screen: ${screen}`,
				'PlayerService'
			);

			// Start the stream
			const process = useStreamlink
				? await this.startStreamlinkProcess(options)
				: await this.startMpvProcess(options);

			// Create stream instance
			const instance: LocalStreamInstance = {
				id: Date.now(),
				screen,
				url: options.url,
				quality: options.quality || 'best',
				status: 'playing',
				volume: options.volume || screenConfig.volume || this.config.player.defaultVolume,
				process,
				platform: options.url.includes('youtube.com') ? 'youtube' : 'twitch',
				title: streamTitle,
				startTime:
					typeof options.startTime === 'string'
						? new Date(options.startTime).getTime()
						: options.startTime,
				options: options
			};

			// Store stream instance
			this.streams.set(screen, instance);

			// Setup monitoring
			this.setupStreamMonitoring(screen, process, options);

			return {
				screen,
				message: `Stream started on screen ${screen}`,
				success: true
			};
		} catch (error) {
			logger.error(
				`Failed to start stream on screen ${screen}`,
				'PlayerService',
				error instanceof Error ? error.message : String(error)
			);
			return {
				screen,
				message: error instanceof Error ? error.message : String(error),
				success: false
			};
		} finally {
			clearTimeout(lockTimeout);
			this.startupLocks.set(screen, false);
		}
	}

	private async startMpvProcess(
		options: StreamOptions & { screen: number }
	): Promise<ChildProcess> {
		const args = this.getMpvArgs(options);
		const env = this.getProcessEnv();

		// Add screen-specific environment variables
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
		env.SCREEN = options.screen.toString();
		env.DATE = timestamp;

		// Sanitize title components to avoid issues with shell escaping
		const streamTitle = (options.title || 'Unknown Title').replace(/['"]/g, '');
		const viewerCount =
			options.viewerCount !== undefined ? `${options.viewerCount} viewers` : 'Unknown viewers';
		const startTime = options.startTime
			? new Date(options.startTime).toLocaleTimeString()
			: 'Unknown time';

		// Set environment variables without quotes
		env.TITLE = `${streamTitle} - ${viewerCount} - ${startTime} - Screen ${options.screen}`;
		env.STREAM_URL = options.url;

		logger.info(`Starting MPV for screen ${options.screen}`, 'PlayerService');
		logger.debug(`MPV command: ${this.mpvPath} ${args.join(' ')}`, 'PlayerService');

		const process = spawn(this.mpvPath, args, {
			env,
			stdio: ['ignore', 'pipe', 'pipe']
		});

		this.setupProcessHandlers(process, options.screen);
		return process;
	}

	private async startStreamlinkProcess(options: StreamOptions & { screen: number }): Promise<ChildProcess> {
		try {
			const args = this.getStreamlinkArgs(options.url, options);
			const env = this.getProcessEnv();

			logger.info(`Starting Streamlink for screen ${options.screen}`, 'PlayerService');
			logger.debug(`Streamlink command: streamlink ${args.join(' ')}`, 'PlayerService');

			const process = spawn('streamlink', args, {
				env,
				stdio: ['ignore', 'pipe', 'pipe']
			});

			return new Promise((resolve, reject) => {
				let errorOutput = '';
				let hasStarted = false;
				const startTimeout = setTimeout(() => {
					const error = new Error('Stream start timeout exceeded');
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
					logger.error(`Streamlink error for screen ${options.screen}`, 'PlayerService', error);
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
						
						reject(new Error(errorMessage));
					}
				};

				process.stdout?.on('data', onData);
				process.stderr?.on('data', (data: Buffer) => {
					errorOutput += data.toString() + '\n';
					onData(data);
				});
				process.on('error', onError);
				process.on('exit', onExit);
			});
		} catch (err) {
			logger.error(
				`Failed to spawn streamlink process for screen ${options.screen}`,
				'PlayerService',
				err instanceof Error ? err.message : String(err)
			);
			throw err;
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
			this.clearMonitoring(screen);
			this.streams.delete(screen);
			this.streamRetries.delete(screen);
		};

		const handleStreamEnd = (error: string | Error, code: number = 0) => {
			if (!hasEndedStream) {
				hasEndedStream = true;
				logger.info(`Stream ended on screen ${screen}`, 'PlayerService');
				this.errorCallback?.({
					screen,
					error: error instanceof Error ? error.message : error,
					code
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
							handleStreamEnd('Stream ended (post-live)');
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
						handleStreamEnd('Stream ended normally');
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
							handleStreamEnd(new Error('Stream unavailable or ended'));
						} else {
							logger.error(`[Screen ${screen}] ${output}`, 'PlayerService');
							this.handleError(screen, new Error(`Stream error: ${output}`));
						}
					}
				}
			});
		}

		process.on('error', (err: Error) => {
			logger.error(`Process error on screen ${screen}`, 'PlayerService', err);
			this.handleError(screen, err);
		});

		process.on('exit', (code: number | null) => {
			logger.info(`Process exited on screen ${screen} with code ${code}`, 'PlayerService');
			handleStreamEnd(new Error(`Process exited with code ${code}`));
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
		}, 30000); // Increased from 60s to 30s for more responsive detection

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
		
		// Add a longer delay to ensure cleanup is complete
		await new Promise((resolve) => setTimeout(resolve, 500));
		
		// Double check no existing process before starting new one
		const existingStream = this.streams.get(screen);
		if (existingStream?.process) {
			logger.warn(`Found existing process for screen ${screen}, forcing cleanup`, 'PlayerService');
			try {
				existingStream.process.kill('SIGKILL');
				await new Promise(resolve => setTimeout(resolve, 200));
			} catch {
				// Process might already be gone
			}
		}
		
		await this.startStream({ ...options, screen });
	}

	private handleProcessExit(screen: number, code: number | null): void {
		// Clear monitoring
		this.clearMonitoring(screen);

		// Get stream options before removing the instance
		const stream = this.streams.get(screen);
		const streamOptions = stream?.options;

		// Remove stream instance
		this.streams.delete(screen);

		// Initialize retry count if not exists
		if (!this.streamRetries.has(screen)) {
			this.streamRetries.set(screen, 0);
		}

		const retryCount = this.streamRetries.get(screen) || 0;
		const MAX_RETRIES = 3;

		// Handle different exit codes
		if (code === 0) {
			// Normal exit - clear retries and move to next stream
			this.streamRetries.delete(screen);
			logger.info(
				`Stream ended normally on screen ${screen}, moving to next stream`,
				'PlayerService'
			);
			this.errorCallback?.({
				screen,
				error: 'Stream ended normally',
				code: 0
			});
		} else if (code === 2) {
			// Streamlink error (usually temporary) - retry with backoff
			if (retryCount < MAX_RETRIES && streamOptions) {
				const backoffTime = Math.min(1000 * Math.pow(2, retryCount), 10000); // Max 10 second backoff
				this.streamRetries.set(screen, retryCount + 1);
				logger.warn(
					`Stream error on screen ${screen} (code ${code}), retry ${retryCount + 1}/${MAX_RETRIES} in ${backoffTime}ms`,
					'PlayerService'
				);
				setTimeout(() => {
					this.startStream(streamOptions).catch(error => {
						logger.error(
							`Failed to restart stream on screen ${screen}`,
							'PlayerService',
							error instanceof Error ? error : new Error(String(error))
						);
					});
				}, backoffTime);
			} else {
				// Max retries reached or no options available - move to next stream
				this.streamRetries.delete(screen);
				logger.error(
					`Stream failed after ${MAX_RETRIES} retries on screen ${screen}, moving to next stream`,
					'PlayerService'
				);
				this.errorCallback?.({
					screen,
					error: `Stream failed after ${MAX_RETRIES} retries`,
					code: -1
				});
			}
		} else {
			// Other error codes - move to next stream
			this.streamRetries.delete(screen);
			logger.error(
				`Stream ended with error code ${code} on screen ${screen}, moving to next stream`,
				'PlayerService'
			);
			this.errorCallback?.({
				screen,
				error: `Stream ended with error code ${code}`,
				code: -1
			});
		}
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

		// Clear other state
		this.streamStartTimes.delete(screen);
		this.streamRetries.delete(screen);
	}

	/**
	 * Stop a stream that is currently playing on a screen
	 */
	async stopStream(screen: number, force: boolean = false): Promise<boolean> {
		logger.debug(`Stopping stream on screen ${screen}`, 'PlayerService');
		
		const player = this.streams.get(screen);
		if (!player || !player.process) {
			logger.debug(`No player to stop on screen ${screen}`, 'PlayerService');
			return true; // Nothing to stop, so consider it a success
		}
		
		// Try graceful shutdown via IPC first
		let gracefulShutdown = false;
		try {
			await this.sendMpvCommand(screen, 'quit');
			
			// Give it a moment to shutdown gracefully
			await new Promise((resolve) => setTimeout(resolve, 500));
			
			// Check if the process has exited
			gracefulShutdown = !this.isProcessRunning(player.process.pid);
			if (gracefulShutdown) {
				logger.debug(`Graceful shutdown successful for screen ${screen}`, 'PlayerService');
			} else {
				logger.debug(`Graceful shutdown failed for screen ${screen}, will try force kill`, 'PlayerService');
			}
		} catch (error) {
			logger.debug(`IPC command failed for screen ${screen}, will try force kill: ${error instanceof Error ? error.message : String(error)}`, 'PlayerService');
		}
		
		// If graceful shutdown failed or force is true, use the forceful method
		if (!gracefulShutdown || force) {
			try {
				player.process.kill('SIGTERM');
				
				// Give it a moment to respond to SIGTERM
				await new Promise((resolve) => setTimeout(resolve, 300));
				
				// Check if we need to force kill with SIGKILL
				if (this.isProcessRunning(player.process.pid)) {
					logger.debug(`SIGTERM didn't work for screen ${screen}, using SIGKILL`, 'PlayerService');
					player.process.kill('SIGKILL');
				}
			} catch (error) {
				logger.error(`Error killing process for screen ${screen}: ${error instanceof Error ? error.message : String(error)}`, 'PlayerService');
			}
		}
		
		// Clean up regardless of kill success
		this.cleanup_after_stop(screen);
		
		return true;
	}
	
	/**
	 * Clean up resources after a stream is stopped
	 */
	private cleanup_after_stop(screen: number): void {
		// Clean up the monitoring interval
		const monitorInterval = this.healthCheckIntervals.get(screen);
		if (monitorInterval) {
			clearInterval(monitorInterval);
			this.healthCheckIntervals.delete(screen);
		}
		
		// Clean up player state
		this.streams.delete(screen);
		this.streamRetries.delete(screen);
		this.streamStartTimes.delete(screen);
		this.streamRefreshTimers.delete(screen);
		this.inactiveTimers.delete(screen);
		this.ipcPaths.delete(screen);
		
		logger.debug(`Cleaned up resources for screen ${screen}`, 'PlayerService');
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
			return true;
		} catch {
			return false;
		}
	}

	private getMpvArgs(options: StreamOptions & { screen: number }): string[] {
		const screenConfig = this.config.player.screens.find((s) => s.screen === options.screen);
		if (!screenConfig) {
			throw new Error(`Invalid screen number: ${options.screen}`);
		}

		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
		const logFile = path.join(
			this.BASE_LOG_DIR,
			'mpv',
			`mpv-screen${options.screen}-${timestamp}.log`
		);
		const homedir = process.env.HOME || process.env.USERPROFILE;
		const ipcPath = homedir
			? path.join(homedir, '.livelink', `mpv-ipc-${options.screen}`)
			: `/tmp/mpv-ipc-${options.screen}`;
		this.ipcPaths.set(options.screen, ipcPath);

		// Get stream metadata for title
		const streamTitle = options.title || 'Unknown Title';
		const viewerCount =
			options.viewerCount !== undefined ? `${options.viewerCount} viewers` : 'Unknown viewers';

		// Sanitize title components to avoid issues with shell escaping
		const sanitizedTitle = streamTitle.replace(/['"]/g, '');

		// Format the title without quotes in the argument
		const titleArg = `--title="${sanitizedTitle} - ${viewerCount} - Screen ${options.screen}"`;

		// Base arguments for MPV direct playback
		const baseArgs = [
			// IPC and config
			`--input-ipc-server=${ipcPath}`,
			`--config-dir=${this.SCRIPTS_PATH}`,
			`--log-file=${logFile}`,
			
			// Window position and size
			`--geometry=${screenConfig.width}x${screenConfig.height}+${screenConfig.x}+${screenConfig.y}`,
			
			// Audio settings
			`--volume=${options.volume !== undefined ? options.volume : screenConfig.volume !== undefined ? screenConfig.volume : this.config.player.defaultVolume}`,
			
			// Title
			titleArg,
			
			// URL must be last
			options.url
		];

		// Combine all arguments
		const allArgs = [
			...baseArgs,
			...(options.windowMaximized || screenConfig.windowMaximized ? ['--window-maximized=yes'] : [])
		];

		return allArgs;
	}

	private getStreamlinkArgs(url: string, options: StreamOptions & { screen: number }): string[] {
		const screen = options.screen;
		const screenConfig = this.config.player.screens.find((s) => s.screen === screen);
		if (!screenConfig) {
			throw new Error(`Invalid screen number: ${screen}`);
		}

		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
		const logFile = path.join(this.BASE_LOG_DIR, 'mpv', `mpv-screen${screen}-${timestamp}.log`);
		const homedir = process.env.HOME || process.env.USERPROFILE;
		const ipcPath = homedir
			? path.join(homedir, '.livelink', `mpv-ipc-${screen}`)
			: `/tmp/mpv-ipc-${screen}`;
		this.ipcPaths.set(screen, ipcPath);

		// Get stream metadata for title
		const streamTitle = options.title || 'Unknown Title';
		const viewerCount =
			options.viewerCount !== undefined ? `${options.viewerCount} viewers` : 'Unknown viewers';
		const sanitizedTitle = streamTitle.replace(/['"]/g, '');
		const titleArg = `--title="${sanitizedTitle} - ${viewerCount} - Screen ${options.screen}"`;

		// MPV arguments specifically for Streamlink
		const mpvArgs = [
			// Window position and size
			`--geometry=${screenConfig.width}x${screenConfig.height}+${screenConfig.x}+${screenConfig.y}`,
			
			// Audio settings
			`--volume=${screenConfig.volume !== undefined ? screenConfig.volume : this.config.player.defaultVolume}`,
			
			// IPC and config
			`--input-ipc-server=${ipcPath}`,
			`--config-dir=${this.SCRIPTS_PATH}`,
			`--log-file=${logFile}`,
			
			// Title
			titleArg,
			
			// Window state
			...(options.windowMaximized || screenConfig.windowMaximized ? ['--window-maximized=yes'] : [])
		].filter(Boolean);

		// Streamlink-specific arguments
		const streamlinkArgs = [
			url,
			'best', // Quality selection
			...(url.includes('youtube.com') ? [
				'--stream-segment-threads=2',  // Reduced from 3 to 2
				'--stream-timeout=60',
				'--hls-segment-threads=2',     // Reduced from 3 to 2
				'--ringbuffer-size=32M',       // Limit ring buffer size
				'--hls-segment-stream-data',   // Stream segments directly
				'--hls-live-edge=2',          // Reduce live edge buffer
				'--stream-segment-attempts=3', // Limit segment retry attempts
				'--player-no-close',          // Don't close player on stream end
				'--hls-playlist-reload-time=2' // Faster playlist reload
			] : []),
			'--player',
			this.mpvPath,
			'--player-args',
			mpvArgs.join(' ')
		];

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
					logger.error(`Failed to send command to screen ${screen}`, 'PlayerService', err instanceof Error ? err : new Error(String(err)));
				}
			});
		} catch (err) {
			logger.error(`Command send error for screen ${screen}`, 'PlayerService', err instanceof Error ? err : new Error(String(err)));
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
		this.errorCallback = callback;
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
			// Stop all streams
			const activeScreens = Array.from(this.streams.keys());
			await Promise.all(activeScreens.map((screen) => this.stopStream(screen, true)));

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
					logger.warn(
						`Failed to remove IPC socket ${ipcPath}`,
						'PlayerService',
						error instanceof Error ? error : new Error(String(error))
					);
				}
			});

			this.ipcPaths.clear();
			this.streams.clear();
			this.manuallyClosedScreens.clear();
			this.disabledScreens.clear();

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

	public async ensurePlayersRunning(): Promise<void> {
		try {
			// Check all screen configs and ensure they have players running if enabled
			for (const screen of this.config.player.screens) {
				// Skip if screen is disabled
				if (!screen.enabled || this.disabledScreens.has(screen.screen) || 
					this.manuallyClosedScreens.has(screen.screen)) {
					logger.debug(`Skipping disabled or manually closed screen ${screen.screen}`, 'PlayerService');
					continue;
				}
				
				// Skip if a stream is already running on this screen
				const isStreamRunning = this.streams.has(screen.screen);
				if (isStreamRunning) {
					continue;
				}
				
				// Start a player with a dummy source
				const options: StreamOptions & { screen: number } = {
					url: 'about:blank', // Use about:blank as dummy source
					screen: screen.screen,
					quality: 'best',
					volume: screen.volume || this.config.player.defaultVolume
				};
				
				try {
					await this.startStream(options);
					logger.info(`Started player for screen ${screen.screen}`, 'PlayerService');
				} catch (error) {
					logger.error(
						`Failed to start player for screen ${screen.screen}`,
						'PlayerService',
						error instanceof Error ? error : new Error(String(error))
					);
				}
			}
		} catch (error) {
			logger.error(
				'Failed to ensure players are running',
				'PlayerService',
				error instanceof Error ? error : new Error(String(error))
			);
		}
	}

	public disableScreen(screen: number): void {
		logger.debug(`PlayerService: Disabling screen ${screen}`, 'PlayerService');
		this.disabledScreens.add(screen);
		
		// Stop any running stream for this screen
		this.stopStream(screen, true).catch(error => {
			logger.error(`Failed to stop stream when disabling screen ${screen}`, 'PlayerService', error);
		});
	}

	public enableScreen(screen: number): void {
		logger.debug(`PlayerService: Enabling screen ${screen}`, 'PlayerService');
		this.disabledScreens.delete(screen);
		this.manuallyClosedScreens.delete(screen);
		
		// Ensure players get restarted on this screen in the next ensurePlayersRunning call
		// We don't start it immediately to allow for proper initialization
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
			logger.warn(
				`Failed to extract title from URL: ${url}`,
				'PlayerService',
				err instanceof Error ? err : new Error(String(err))
			);
			return 'Unknown Stream';
		}
	}

	/**
	 * Sends a command directly to the MPV IPC socket
	 */
	private async sendMpvCommand(screen: number, command: string): Promise<void> {
		const ipcPath = this.ipcPaths.get(screen);
		if (!ipcPath) {
			const errorMessage = `No IPC socket for screen ${screen}`;
			this.logError(`Command error on screen ${screen}: ${errorMessage}`);
			return Promise.reject(errorMessage);
		}
		
		return new Promise((resolve, reject) => {
			try {
				const socket = net.createConnection(ipcPath);
				
				socket.on('connect', () => {
					const mpvCommand = JSON.stringify({ command: [command] });
					socket.write(mpvCommand + '\n');
					socket.end();
					resolve();
				});
				
				socket.on('error', (err: Error) => {
					const errorMessage = err.message;
					this.logError(`Command error on screen ${screen}: ${errorMessage}`);
					reject(errorMessage);
				});
				
				socket.setTimeout(1000, () => {
					socket.destroy();
					const errorMessage = 'Socket timeout';
					this.logError(`Command error on screen ${screen}: ${errorMessage}`);
					reject(errorMessage);
				});
			} catch (err) {
				const errorMessage = err instanceof Error ? err.message : String(err);
				this.logError(`Command error on screen ${screen}: ${errorMessage}`);
				reject(errorMessage);
			}
		});
	}

	private handleError(screen: number, error: unknown): void {
		const errorMessage = error instanceof Error ? error.message : String(error);
		logger.error(`Stream error on screen ${screen}: ${errorMessage}`, 'PlayerService', errorMessage);
		
		if (this.errorCallback) {
			this.errorCallback({
				screen,
				error: errorMessage,
				code: -1
			});
		}
	}

	private handleStreamEnd(screen: number, error?: unknown): void {
		const errorMessage = error instanceof Error ? error.message : error ? String(error) : undefined;
		
		if (this.endCallback) {
			this.endCallback({
				screen,
				error: errorMessage
			});
		}
		
		logger.info(`Stream ended on screen ${screen}${errorMessage ? `: ${errorMessage}` : ''}`, 'PlayerService');
	}

	private logError(message: string): void {
		logger.error(message, 'PlayerService');
	}

	private handleProcessError(screen: number, error: unknown): void {
		const errorMessage = error instanceof Error ? error.message : String(error);
		this.handleError(screen, errorMessage);
	}
}
